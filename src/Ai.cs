using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Workspace;

/// <summary>
/// The English coach: one OpenAI-compatible chat call, plus the DPAPI-wrapped
/// key that pays for it. The page never sees the key, and the key never lands
/// in index.json — that file is plain text and gets copied around with the data
/// folder. Nothing here runs unless the user presses something or pauses typing.
/// </summary>
public static class Ai
{
    const string DefaultBase = "https://api.deepseek.com";
    const string DefaultModel = "deepseek-chat";

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(90) };
    static readonly JsonSerializerOptions Compact = new() { Encoder = Json.Opt.Encoder };

    static Settings Cfg => Store.Idx.Settings;
    static string KeyFile => Path.Combine(Store.DataDir, "secret.bin");

    // ---------------------------------------------------------------- secrets
    public static bool HasKey()
    {
        try { return File.Exists(KeyFile) && new FileInfo(KeyFile).Length > 0; }
        catch { return false; }
    }

    public static void SaveKey(string key)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(key))
            {
                if (File.Exists(KeyFile)) File.Delete(KeyFile);
                return;
            }
            Directory.CreateDirectory(Store.DataDir);
            File.WriteAllBytes(KeyFile, Dpapi(Encoding.UTF8.GetBytes(key.Trim()), true));
        }
        catch (Exception e) { throw new Bridge.BridgeError("保存 key 失败：" + e.Message); }
    }

    static string ReadKey()
    {
        try
        {
            if (!HasKey()) return "";
            return Encoding.UTF8.GetString(Dpapi(File.ReadAllBytes(KeyFile), false)).Trim();
        }
        catch { return ""; }
    }

    // DPAPI without the extra NuGet package: crypt32 is part of Windows anyway.
    [StructLayout(LayoutKind.Sequential)]
    struct DataBlob { public int cbData; public IntPtr pbData; }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CryptProtectData(ref DataBlob pDataIn, string szDataDescr,
        IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DataBlob pDataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CryptUnprotectData(ref DataBlob pDataIn, IntPtr ppszDataDescr,
        IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DataBlob pDataOut);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    /// <summary>Ties the blob to this Windows account: a copied file is useless elsewhere.</summary>
    static byte[] Dpapi(byte[] data, bool protect)
    {
        if (data == null || data.Length == 0) return Array.Empty<byte>();
        var input = new DataBlob();
        var output = new DataBlob();
        var pin = GCHandle.Alloc(data, GCHandleType.Pinned);
        try
        {
            input.cbData = data.Length;
            input.pbData = pin.AddrOfPinnedObject();
            const int UiForbidden = 0x1;
            var ok = protect
                ? CryptProtectData(ref input, "workspace ai key", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, UiForbidden, ref output)
                : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, UiForbidden, ref output);
            if (!ok)
                throw new Bridge.BridgeError((protect ? "加密" : "解密") + " key 失败（" + Marshal.GetLastWin32Error() + "）");
            var result = new byte[output.cbData];
            Marshal.Copy(output.pbData, result, 0, output.cbData);
            return result;
        }
        finally
        {
            pin.Free();
            if (output.pbData != IntPtr.Zero) LocalFree(output.pbData);
        }
    }

    // ------------------------------------------------------------------ routes
    public static object Status() => new
    {
        hasKey = HasKey(),
        baseUrl = Cfg.AiBaseUrl,
        model = Cfg.AiModel,
        auto = Cfg.AiAutoSuggest,
        delay = Cfg.AiDelayMs,
        tokens = Cfg.AiTokens
    };

    public static object ResetTokens()
    {
        Cfg.AiTokens = 0;
        Store.SaveIndex();
        return new { ok = true };
    }

    public static async Task<object> Test()
    {
        var reply = await ChatAsync("You are a connectivity probe. Reply with exactly: OK", "ping", 16);
        return new { ok = true, text = Clip(reply.Text, 60), tokens = reply.Total, total = Cfg.AiTokens };
    }

    /// <summary>One Chinese fragment → two English options that fit where it sat.</summary>
    public static async Task<object> Suggest(string draft, string fragment, string left, string right)
    {
        if (string.IsNullOrWhiteSpace(fragment)) throw new Bridge.BridgeError("没有选中中文片段");
        var user = JsonSerializer.Serialize(new
        {
            draft = Clip(draft, 1200),
            fragment = Clip(fragment, 120),
            left = Clip(left, 240),
            right = Clip(right, 240)
        }, Compact);

        var root = await AskJson(SUGGEST_SYSTEM, user, 400);
        var (options, note) = ReadOptions(root);
        // The model sometimes writes the same sentence twice; ask once more for a
        // genuinely different short version instead of showing one lonely option.
        if (options.Count < 2)
        {
            var retry = await AskJson(SUGGEST_SYSTEM,
                user + "\n\n上一次你给的两个选项文字完全相同。这次换一种真正不同的说法，给出简洁版，不要与自然版重复。", 400);
            var (more, moreNote) = ReadOptions(retry);
            var have = new HashSet<string>(options.Select(x => x.En));
            foreach (var item in more)
            {
                if (options.Count >= 2) break;
                if (have.Add(item.En)) options.Add(item);
            }
            if (note == "") note = moreNote;
        }

        return new
        {
            options = options.Select(x => new { en = x.En, register = x.Reg }).ToList(),
            note,
            tokens = Cfg.AiTokens
        };
    }

    sealed class EnOption { public string En = ""; public string Reg = "natural"; }

    static (List<EnOption> options, string note) ReadOptions(JsonElement root)
    {
        var list = new List<EnOption>();
        var seen = new HashSet<string>();
        if (root.TryGetProperty("options", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in arr.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                var en = Clip(Str(item, "en"), 600);
                if (en == "" || !seen.Add(en)) continue;
                list.Add(new EnOption { En = en, Reg = Str(item, "register") == "concise" ? "concise" : "natural" });
                if (list.Count == 2) break;
            }
        }
        return (list, Clip(Str(root, "note"), 120));
    }

    /// <summary>
    /// Revise a note. Mostly-English notes get grammar and sharpening; notes that
    /// are mostly Chinese get rewritten into English, because a Chinese note is
    /// exactly the thing an English-only workspace wants converted.
    /// </summary>
    public static async Task<object> Check(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) throw new Bridge.BridgeError("条目是空的");
        if (text.Length > 8000) throw new Bridge.BridgeError("条目太长（" + text.Length + " 字符，上限 8000），先分节再检查");

        var revise = MostlyChinese(text);
        var system = revise ? REVISE_SYSTEM : CHECK_SYSTEM;
        var user = JsonSerializer.Serialize(new { text }, Compact);
        var root = await AskJson(system, user, revise ? 2400 : 900);

        var issues = new List<object>();
        var seen = new HashSet<string>();
        if (root.TryGetProperty("issues", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in arr.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                var original = Clip(Str(item, "original"), 400);
                var replacement = Clip(Str(item, "replacement"), 400);
                if (original == "" || original == replacement) continue;
                // The Client replaces by substring; an unfindable span would do nothing.
                if (!text.Contains(original, StringComparison.Ordinal)) continue;
                if (!seen.Add(original + "\u0000" + replacement)) continue;
                var severity = Str(item, "severity") == "improve" ? "improve" : "error";
                issues.Add(new
                {
                    original,
                    replacement,
                    type = Clip(Str(item, "type"), 40) is { Length: > 0 } t ? t : "phrasing",
                    severity,
                    message = Clip(Str(item, "message"), 240)
                });
                if (issues.Count == (revise ? 12 : 20)) break;
            }
        }

        var corrected = Clip(Str(root, "corrected"), 12000);
        if (corrected == "") corrected = text;
        var summary = Clip(Str(root, "summary"), 160);
        if (summary == "") summary = issues.Count == 0 ? "没有发现问题" : "发现 " + issues.Count + " 处可修改";
        return new { mode = revise ? "revise" : "check", issues, corrected, summary, tokens = Cfg.AiTokens };
    }

    /// <summary>Chinese characters outweigh Latin ones — treat it as a translation job.</summary>
    static bool MostlyChinese(string text)
    {
        int cjk = 0, latin = 0;
        foreach (var ch in text)
        {
            if (ch >= '\u3400' && ch <= '\u9fff') cjk++;
            else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) latin++;
        }
        return cjk > 0 && cjk * 2 >= latin;
    }

    // ---------------------------------------------------------------- model I/O
    sealed class Reply { public string Text = ""; public int Prompt; public int Completion; public int Total; public string Finish = ""; public int Reasoning; }

    static async Task<Reply> ChatAsync(string system, string user, int maxTokens)
    {
        var key = ReadKey();
        if (key == "") throw new Bridge.BridgeError("还没有配置模型 key：设置 → English");

        var model = string.IsNullOrWhiteSpace(Cfg.AiModel) ? DefaultModel : Cfg.AiModel.Trim();
        var url = Endpoint(Cfg.AiBaseUrl);

        var body = new Dictionary<string, object>
        {
            ["model"] = model,
            ["messages"] = new object[]
            {
                new { role = "system", content = system },
                new { role = "user", content = user }
            },
            ["temperature"] = 0.2,
            ["max_tokens"] = maxTokens,
            ["stream"] = false
        };
        // DeepSeek's newer models think first by default, and the thinking eats the
        // token budget before any text is written. These are short rewrite jobs, so
        // ask for the non-thinking answer. Other endpoints may reject the field.
        if (IsDeepSeek(url) || model.StartsWith("deepseek", StringComparison.OrdinalIgnoreCase))
            body["thinking"] = new { type = "disabled" };

        var payload = JsonSerializer.Serialize(body, Compact);

        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        req.Content = new StringContent(payload, Encoding.UTF8, "application/json");

        HttpResponseMessage res;
        try { res = await Http.SendAsync(req); }
        catch (TaskCanceledException) { throw new Bridge.BridgeError("模型超时（90 秒）"); }
        catch (Exception e) { throw new Bridge.BridgeError("连不上模型：" + Head(e.Message)); }

        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
            throw new Bridge.BridgeError("模型返回 " + (int)res.StatusCode + "：" + Head(text));

        var reply = new Reply();
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.TryGetProperty("choices", out var choices) && choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() > 0)
            {
                var first = choices[0];
                reply.Finish = Str(first, "finish_reason");
                if (first.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.Object)
                    reply.Text = Str(message, "content");
            }
            if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
            {
                reply.Prompt = Int(usage, "prompt_tokens");
                reply.Completion = Int(usage, "completion_tokens");
                reply.Total = Int(usage, "total_tokens");
                if (reply.Total <= 0) reply.Total = reply.Prompt + reply.Completion;
                if (usage.TryGetProperty("completion_tokens_details", out var details) && details.ValueKind == JsonValueKind.Object)
                    reply.Reasoning = Int(details, "reasoning_tokens");
            }
        }
        catch (JsonException) { throw new Bridge.BridgeError("模型返回的不是 JSON：" + Head(text)); }

        if (reply.Text.Trim() == "")
        {
            var why = reply.Finish == "length"
                ? "（额度被截断，思考过程可能吃光了 max_tokens）"
                : reply.Reasoning > 0 ? "（只输出了思考过程，没有正文）" : "";
            throw new Bridge.BridgeError("模型没有回正文" + why);
        }

        Cfg.AiTokens += reply.Total;
        Store.SaveIndex();
        return reply;
    }

    static bool IsDeepSeek(string url)
        => url.Contains("api.deepseek.com", StringComparison.OrdinalIgnoreCase);

    /// <summary>Parse the reply as one JSON object, retrying once with a repair line.</summary>
    static async Task<JsonElement> AskJson(string system, string user, int maxTokens)
    {
        var first = await ChatAsync(system, user, maxTokens);
        var parsed = ExtractJson(first.Text);
        if (parsed.HasValue) return parsed.Value;

        var second = await ChatAsync(system,
            user + "\n\n上一次的回复无法解析。只输出一个 JSON 对象，不要解释，不要代码围栏。", maxTokens);
        parsed = ExtractJson(second.Text);
        if (parsed.HasValue) return parsed.Value;
        throw new Bridge.BridgeError("模型回了看不懂的内容");
    }

    static JsonElement? ExtractJson(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var body = text.Trim();
        var fence = Regex.Match(body, "```(?:json|JSON)?\\s*([\\s\\S]*?)```");
        if (fence.Success) body = fence.Groups[1].Value.Trim();
        var start = body.IndexOf('{');
        var end = body.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            using var doc = JsonDocument.Parse(body.Substring(start, end - start + 1));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            return doc.RootElement.Clone();
        }
        catch { return null; }
    }

    /// <summary>Accept a bare host, /v1, or a full endpoint — people paste all three.</summary>
    static string Endpoint(string baseUrl)
    {
        var url = (baseUrl ?? "").Trim().TrimEnd('/');
        if (url == "") url = DefaultBase;
        if (!url.Contains("://")) url = "https://" + url;
        if (url.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)) return url;
        if (url.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) return url + "/chat/completions";
        return url + "/v1/chat/completions";
    }

    static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? "" : "";

    static int Int(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetInt32() : 0;

    static string Clip(string value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text.Substring(0, max);
    }

    static string Head(string value, int max = 300)
    {
        var text = (value ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
        return text.Length <= max ? text : text.Substring(0, max) + "…";
    }

    // ----------------------------------------------------------------- prompts
    const string SUGGEST_SYSTEM = """
You are an English writing coach for a Chinese-speaking software engineer who is writing a note in their own workspace.

Task: turn the Chinese fragment into English that can replace that fragment in place, inside the surrounding note.

Rules:
- Keep the surrounding English, code, file names, product names and technical terms exactly as they are.
- The replacement must fit grammatically where the Chinese fragment sits. Do not add greetings, explanations or quotation marks.
- Prefer how a fluent developer would actually write in a note: direct, natural, not textbook-stiff.
- Give exactly two options, worded differently: one with register "natural" (most idiomatic) and one with register "concise" (shorter). If the natural option is already short, the concise one must be a different construction, not a copy.
- "note" is one short Simplified-Chinese hint (at most 20 characters) about a word choice or grammar point; use "" when nothing is worth saying.
- Only handle the given fragment. Do not rewrite anything else.

Return ONLY one JSON object with this shape, no markdown fence and no commentary:
{"options":[{"en":"...","register":"natural"},{"en":"...","register":"concise"}],"note":"..."}
""";

    const string CHECK_SYSTEM = """
You are a meticulous English editor for personal notes written by a Chinese-speaking developer. You do two jobs at once: fix what is wrong, and sharpen what is correct but weak.

1. Errors — grammar, tense, subject-verb agreement, articles, prepositions, countable/uncountable nouns, word choice, punctuation that changes meaning.
2. Improvements — correct English that is vague, wordy, flat, or unnatural. Typical wins: a vague noun becomes concrete (thing → bug), a weak verb becomes specific (do something → fix), stacked qualifiers collapse into one precise phrase (very, very bad → crashes constantly).

Rules:
- Keep the writer's meaning, tone and level of formality. Do not add facts, opinions or filler.
- Do not touch Chinese text, code, URLs, file paths or technical identifiers.
- Prefer one strong, minimal edit over a full-sentence rewrite. Never stack several small edits on the same clause.
- For each issue, "original" must be an exact substring copied from the input, long enough to be unambiguous (usually 2-12 words). "replacement" must fix only that substring.
- Issues must not overlap. Return at most 6 issues, errors first.
- "type" is one of: grammar, tense, agreement, article, preposition, word-choice, punctuation, phrasing, expression.
- "severity" is "error" for clearly wrong English, "improve" for correct English that can be made clearer, tighter or more vivid.
- "message" is one short Simplified-Chinese sentence explaining the fix or the gain.
- "corrected" is the full note with every issue applied, preserving everything you did not flag.
- If nothing is wrong and nothing is worth improving, return an empty issues array and the input unchanged.

Return ONLY one JSON object, no markdown fence and no commentary:
{"issues":[{"original":"...","replacement":"...","type":"grammar","severity":"error","message":"..."}],"corrected":"...","summary":"..."}
""";

    const string REVISE_SYSTEM = """
You are an English editor converting a Chinese-speaking engineer's personal note into English.

Task: rewrite the note so every Chinese phrase becomes natural English, while keeping its structure and every fact intact.

Rules:
- Do not add, drop or reinterpret facts, steps, numbers or names.
- Keep code, URLs, file paths, identifiers and product names unchanged, character for character.
- Keep the same structure and order: same headings, same paragraphs, same list items, same line breaks.
- "issues" lists the Chinese spans you replaced: "original" must be an exact substring copied from the input (the Chinese span, usually 2-12 characters, unique enough to be unambiguous); "replacement" is its English; "type" is "translate"; "severity" is "improve"; "message" is one short Simplified-Chinese note (at most 20 characters) about the word choice.
- Issues must not overlap; cover the note in reading order. Return at most 12.
- "corrected" is the whole note in English.
- If the note is already English, return an empty issues array and the input unchanged.

Return ONLY one JSON object, no markdown fence and no commentary:
{"issues":[{"original":"...","replacement":"...","type":"translate","severity":"improve","message":"..."}],"corrected":"...","summary":"..."}
""";
}
