// North Pole Phone backend: one function, JSON actions, guarded by a family passcode.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1/base64";

const env = (k: string) => Deno.env.get(k) ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-family-code, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const MODEL = () => env("CLAUDE_MODEL") || "claude-haiku-5-5";
const SECRETS = ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "FAMILY_CODE"];

class Upstream extends Error {
  constructor(public service: string, public detail: string) { super(`${service}: ${detail}`); }
}

type Ch = { name: string; persona: string; speed: number; gender: string; ages: string[]; words: string[];
  pick: string; saved: (i: string) => string; unheard: string };
const CH: Record<string, Ch> = {
  santa: { name: "Santa", speed: 0.92, gender: "male", ages: ["old"], words: ["santa", "deep", "grandpa", "warm", "jolly", "gravel", "story", "wise"],
    persona: "Santa Claus himself: jolly, warm and grandfatherly. You say 'Ho ho ho' now and then, not in every line.",
    pick: "Which one do you like best? Tap it!", saved: (i) => `Wonderful choice! I wrote ${i} on your list. Would you like anything else?`,
    unheard: "Ho ho ho! My ears are full of snow. Can you say that again?" },
  mrs: { name: "Mrs. Claus", speed: 0.95, gender: "female", ages: ["old", "middle"], words: ["grandma", "warm", "kind", "gentle", "soft", "mature", "calm"],
    persona: "Mrs. Claus: kind, cozy and grandmotherly, always baking cookies. You call the child 'dear' and pass her wishes along to Santa.",
    pick: "Oh, how lovely! Which one do you like best, dear?", saved: (i) => `Lovely! I will tell Santa you would like ${i}. Anything else, dear?`,
    unheard: "Oh dear, the oven timer was ringing. Can you say that again?" },
  comet: { name: "Comet", speed: 1.05, gender: "male", ages: ["young"], words: ["playful", "energetic", "friendly", "bright", "cheer", "youth", "fun"],
    persona: "Comet, one of Santa's sleigh reindeer: sporty, cheerful and a little goofy. You love carrots and flying practice, and you carry wishes to Santa.",
    pick: "Look what I found! Which one do you like best?", saved: (i) => `Got it! I'll trot over and tell Santa you want ${i}. Anything else for the sleigh?`,
    unheard: "Whoa, the wind was whooshing in my ears! Can you say that again?" },
  pepper: { name: "Pepper", speed: 1.1, gender: "female", ages: ["young"], words: ["child", "cute", "high", "animated", "bubbly", "sweet", "girl", "cheer", "playful"],
    persona: "Pepper, a girl elf who works in Santa's toy workshop: bubbly, quick and very excited about toys. You pin wishes to Santa's list.",
    pick: "Ta-da! Which one do you like best?", saved: (i) => `Yay! I pinned ${i} to Santa's list for you. Want to add more?`,
    unheard: "Oops, a toy train went choo choo right by my ear! Can you say that again?" },
  flurry: { name: "Flurry", speed: 1.0, gender: "male", ages: ["middle", "young"], words: ["goofy", "character", "cartoon", "silly", "funny", "quirky", "animated"],
    persona: "Flurry, a very silly snowman who loves snow puns and jokes. You send wishes to Santa by snowflake.",
    pick: "Snow way! Look at these! Which one do you like best?", saved: (i) => `Cool! One snowflake message to Santa: ${i}. Anything else?`,
    unheard: "Brrr, my ears froze for a second! Can you say that again?" },
};

const str = (v: unknown, n: number) => (typeof v === "string" ? v : "").slice(0, n);

// ---------- ElevenLabs ----------
const EL = "https://api.elevenlabs.io";
async function elVoices() {
  const r = await fetch(`${EL}/v1/voices`, { headers: { "xi-api-key": env("ELEVENLABS_API_KEY") } });
  if (!r.ok) throw new Upstream("elevenlabs", `voices ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.voices ?? []).map((v: any) => ({
    id: v.voice_id, name: v.name, category: v.category ?? "",
    gender: v.labels?.gender ?? "", age: v.labels?.age ?? "",
    about: [v.labels?.descriptive, v.labels?.description, v.labels?.use_case, v.labels?.accent, v.description].filter(Boolean).join(" "),
  }));
}
async function voiceMap(): Promise<Record<string, string>> {
  const { data } = await db.from("settings").select("value").eq("key", "voices").maybeSingle();
  const map: Record<string, string> = (data?.value as Record<string, string>) ?? {};
  if (Object.keys(CH).every((k) => map[k])) return map;
  const voices = await elVoices();
  if (!voices.length) throw new Upstream("elevenlabs", "this account has no voices");
  const used = new Set(Object.values(map));
  for (const k of Object.keys(CH)) {
    if (map[k]) continue;
    const c = CH[k];
    let best = voices[0], bestScore = -99;
    for (const v of voices) {
      const text = `${v.name} ${v.about}`.toLowerCase();
      let s = 0;
      if (v.gender === c.gender) s += 4;
      if (c.ages.some((a) => v.age.includes(a))) s += 2;
      for (const w of c.words) if (text.includes(w)) s += 1;
      if (used.has(v.id)) s -= 3;
      if (s > bestScore) { best = v; bestScore = s; }
    }
    map[k] = best.id; used.add(best.id);
  }
  await db.from("settings").upsert({ key: "voices", value: map, updated_at: new Date().toISOString() });
  return map;
}
async function tts(character: string, text: string): Promise<string> {
  const map = await voiceMap();
  const r = await fetch(`${EL}/v1/text-to-speech/${map[character]}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": env("ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5", voice_settings: { stability: 0.45, similarity_boost: 0.8, speed: CH[character].speed } }),
  });
  if (!r.ok) throw new Upstream("elevenlabs", `speech ${r.status} ${(await r.text()).slice(0, 200)}`);
  return encodeBase64(new Uint8Array(await r.arrayBuffer()));
}
async function stt(audioB64: string, mime: string): Promise<string> {
  const bytes = decodeBase64(audioB64);
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("language_code", "en");
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([bytes], { type: mime || "audio/webm" }), mime.includes("mp4") ? "talk.mp4" : mime.includes("wav") ? "talk.wav" : "talk.webm");
  const r = await fetch(`${EL}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": env("ELEVENLABS_API_KEY") }, body: form });
  if (!r.ok) throw new Upstream("elevenlabs", `listening ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return str(d.text, 400).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

// ---------- Claude ----------
async function claude(body: Record<string, unknown>) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL(), ...body }),
  });
  if (!r.ok) throw new Upstream("anthropic", `${r.status} ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}
const textOf = (resp: any) => (resp.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();

// ---------- data ----------
async function loadState() {
  const [k, w] = await Promise.all([
    db.from("kids").select("id,name").order("created_at"),
    db.from("wishes").select("id,kid_id,name,description,query,price,emoji,asin,url,from_character,bought,created_at").order("created_at"),
  ]);
  if (k.error) throw new Upstream("database", k.error.message);
  if (w.error) throw new Upstream("database", w.error.message);
  return { kids: k.data ?? [], wishes: w.data ?? [] };
}
const asinOf = (u: string) => {
  const m = /amazon\.com\/(?:[^\s"]*?\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i.exec(u || "");
  return m ? m[1].toUpperCase() : "";
};

// ---------- actions ----------
async function talk(p: any) {
  const c = CH[p.character]; if (!c) return json({ error: "bad_character" }, 400);
  const state = await loadState();
  const kid = state.kids.find((k) => k.id === p.kidId); if (!kid) return json({ error: "bad_kid" }, 400);
  let mine = state.wishes.filter((w) => w.kid_id === kid.id);

  let heard = "";
  if (p.event === "start") heard = "(The phone call just connected.)";
  else if (typeof p.text === "string" && p.text.trim()) heard = str(p.text.trim(), 300);
  else if (typeof p.audio === "string" && p.audio.length > 200) heard = await stt(p.audio, str(p.mime, 60));
  if (!heard) return json({ heard: "", say: c.unheard, audio: await tts(p.character, c.unheard), action: null, wishes: state.wishes });

  const history = (Array.isArray(p.history) ? p.history : [])
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-24).map((m: any) => ({ role: m.role, content: m.content.slice(0, 500) }));
  while (history.length && history[0].role !== "user") history.shift();

  const list = mine.length ? mine.map((w, i) => `${i + 1}. ${w.name}`).join("\n") : "(empty)";
  const system = `You are ${c.persona}
You are on a pretend phone call inside a family's Christmas app with ${kid.name}, a young girl between 4 and 8 years old. Everything you write is spoken aloud by a voice, so write only the words you say: no stage directions, no emoji, no asterisks, no lists.

Rules:
- You are a friendly companion she can chat with about anything a young child is curious about: animals, space, how things work, school, her day, stories, jokes, riddles, guessing games, and life at the North Pole. Answer her questions truthfully in simple words a 5 year old understands. If you do not know or are not sure, say so. Christmas wishes are only one of the things you talk about, so do not steer every turn back to presents.
- Replies are spoken, so keep them short: usually one to three sentences. A story, joke or explanation she asked for can run to about six short sentences.
- Often end with a friendly question or an invitation to keep chatting, but not every single time.
- Always stay in character and keep the Christmas magic alive: answer questions about Santa, the reindeer and the North Pole the way your character would. Be warm, playful and kind. Never scary, never sad.
- Her words reach you through speech recognition and may be garbled. Guess kindly; if you really cannot tell, ask her to say it again.
- Only when she clearly says she WANTS something for Christmas, or asks to add something to her list, say one short excited line and call show_gift_options with what she wants. The app then shows her pictures to choose from, so do not describe products yourself. Just talking about a toy or an animal is not a wish; if you are unsure, ask whether she would like it on her list.
- Never promise that she will get a gift. Say you will put it on the list, or that you will see what the elves can do.
- If she asks what is on her list, read it to her. If she wants something taken off, call remove_from_list with its number and tell her it is crossed off.
- When she says goodbye or wants to stop, say a short goodbye and call end_call.
- Never ask for or repeat personal details such as an address, school name, last name or password, and never suggest keeping secrets from her parents. If she brings up something worrying, unsafe or grown-up, or asks about health or anything that needs an adult, gently say that is a good thing to ask Mom or Dad, then move to something cheerful.
- If she asks for something unsafe or something that is not a gift (a real animal, a weapon), cheerfully steer to a toy version.
- When the first message says the call just connected, greet her by name. If her list is not empty you may mention one thing on it. Then ask what she would like to talk about, or what she would like for Christmas.

Her Christmas list right now:
${list}`;

  const resp = await claude({
    max_tokens: 450, system,
    messages: [...history, { role: "user", content: heard }],
    tools: [
      { name: "show_gift_options", description: "Show the child pictures of real gift options to pick from, for something she said she wants.",
        input_schema: { type: "object", properties: { wish: { type: "string", description: "What she wants, in a few plain words, e.g. 'unicorn stuffed animal'" } }, required: ["wish"] } },
      { name: "remove_from_list", description: "Take one item off her Christmas list.",
        input_schema: { type: "object", properties: { item_number: { type: "integer", description: "The number of the item in her list" } }, required: ["item_number"] } },
      { name: "end_call", description: "End the phone call after saying goodbye.", input_schema: { type: "object", properties: {} } },
    ],
  });
  let say = textOf(resp).replace(/[*_#]/g, "").slice(0, 900);
  const tool = (resp.content ?? []).find((b: any) => b.type === "tool_use");
  let action: Record<string, unknown> | null = null;
  let wishes = state.wishes;
  if (tool?.name === "show_gift_options") {
    action = { type: "options", wish: str(tool.input?.wish, 120) || heard };
    if (!say) say = "Ooh, let me look in the workshop!";
  } else if (tool?.name === "remove_from_list") {
    const w = mine[Number(tool.input?.item_number) - 1];
    if (w) {
      await db.from("wishes").delete().eq("id", w.id);
      wishes = wishes.filter((x) => x.id !== w.id);
      action = { type: "removed", wishId: w.id };
      if (!say) say = `All right, I crossed ${w.name} off your list.`;
    } else if (!say) say = "Hmm, I could not find that one on your list. Which one should I take off?";
  } else if (tool?.name === "end_call") {
    action = { type: "bye" };
    if (!say) say = `Goodbye, ${kid.name}! Merry Christmas!`;
  }
  if (!say) say = c.unheard;
  return json({ heard, say, audio: await tts(p.character, say), action, wishes });
}

async function options(p: any) {
  const c = CH[p.character]; if (!c) return json({ error: "bad_character" }, 400);
  const state = await loadState();
  const have = state.wishes.filter((w) => w.kid_id === p.kidId).map((w) => w.name);
  const wish = str(p.wish, 120); if (!wish) return json({ error: "no_wish" }, 400);
  const skip = (Array.isArray(p.exclude) ? p.exclude : []).map((s: unknown) => str(s, 80)).filter(Boolean).slice(0, 12);
  const prompt = `Find 3 different real toys or gifts sold on Amazon.com for a girl aged 4 to 8 who asked Santa for: "${wish}".
Already on her list: ${have.length ? have.join("; ") : "nothing yet"}.${skip.length ? `\nShe already looked at these and wants DIFFERENT ones: ${skip.join("; ")}.` : ""}
They must be safe and right for ages 4 to 8, and usually under $60 unless she clearly asked for something bigger like a bike. If the wish is not something a store sells, is unsafe, or is a live animal, pick fun toy versions of it. If she named a specific product, make option 1 exactly that.
Reply with ONLY a JSON array of 3 objects and no other text. Each object:
{"name": "product name, 6 words at most", "desc": "why it is fun, 10 words at most, for a child", "price": "rough price like $25", "query": "search words that find this exact product", "url": "the amazon.com product page URL copied exactly from a search result, or an empty string if you have none", "emoji": "one emoji"}`;

  const run = async (search: boolean) => {
    const resp = await claude({
      max_tokens: 900, messages: [{ role: "user", content: prompt }],
      ...(search ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2, allowed_domains: ["amazon.com"] }] } : {}),
    });
    const seen = new Set<string>();
    for (const b of resp.content ?? []) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) { const a = asinOf(r?.url ?? ""); if (a) seen.add(a); }
    }
    const t = textOf(resp); const i = t.indexOf("["), j = t.lastIndexOf("]");
    const arr = JSON.parse(t.slice(i, j + 1));
    return (Array.isArray(arr) ? arr : []).slice(0, 3).map((o: any) => {
      const a = asinOf(str(o.url, 300));
      const asin = a && seen.has(a) ? a : ""; // only trust product pages the search really returned
      const query = str(o.query, 120) || str(o.name, 80);
      return { name: str(o.name, 80), desc: str(o.desc, 120), price: str(o.price, 20), query, emoji: str(o.emoji, 8) || "🎁", asin,
        url: asin ? `https://www.amazon.com/dp/${asin}` : `https://www.amazon.com/s?k=${encodeURIComponent(query)}` };
    }).filter((o: any) => o.name);
  };
  let list: any[] = []; let searched = true; let note = "";
  try { list = await run(true); } catch (e) { searched = false; note = e instanceof Error ? e.message.slice(0, 200) : "search failed"; }
  if (!list.length) { searched = false; try { list = await run(false); } catch (e) { if (e instanceof Upstream) throw e; } }
  if (!list.length) list = [{ name: wish, desc: "Just what you asked for", price: "", query: wish, emoji: "🎁", asin: "", url: `https://www.amazon.com/s?k=${encodeURIComponent(wish)}` }];
  return json({ options: list, say: c.pick, audio: await tts(p.character, c.pick), searched, note });
}

async function pick(p: any) {
  const c = CH[p.character]; if (!c) return json({ error: "bad_character" }, 400);
  const o = p.option ?? {};
  const name = str(o.name, 80); if (!name) return json({ error: "no_option" }, 400);
  const asin = /^[A-Z0-9]{10}$/.test(o.asin ?? "") ? o.asin : "";
  const query = str(o.query, 120) || name;
  const { error } = await db.from("wishes").insert({
    kid_id: p.kidId, name, description: str(o.desc, 120), query, price: str(o.price, 20), emoji: str(o.emoji, 8) || "🎁", asin,
    url: asin ? `https://www.amazon.com/dp/${asin}` : `https://www.amazon.com/s?k=${encodeURIComponent(query)}`, from_character: c.name,
  });
  if (error) throw new Upstream("database", error.message);
  const say = c.saved(name);
  return json({ say, audio: await tts(p.character, say), wishes: (await loadState()).wishes });
}

function testWav(): Uint8Array {
  const rate = 16000, n = rate * 0.6, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 440 * i / rate) * 3000, true);
  return new Uint8Array(buf);
}
async function selfTest() {
  const out: Record<string, string> = {};
  try { await loadState(); out.database = "ok"; } catch (e) { out.database = String(e).slice(0, 200); }
  try { await claude({ max_tokens: 5, messages: [{ role: "user", content: "Say hi" }] }); out.anthropic = "ok"; } catch (e) { out.anthropic = String(e).slice(0, 300); }
  try { const v = await elVoices(); out.elevenlabs = v.length ? "ok" : "no voices in this account"; } catch (e) { out.elevenlabs = String(e).slice(0, 300); }
  try { const a = await tts("santa", "Ho ho ho."); out["speaking (text to speech)"] = a.length > 500 ? "ok" : "empty audio"; } catch (e) { out["speaking (text to speech)"] = String(e).slice(0, 300); }
  try { await stt(encodeBase64(testWav()), "audio/wav"); out["listening (speech to text)"] = "ok"; } catch (e) { out["listening (speech to text)"] = String(e).slice(0, 300); }
  return json({ test: out, model: MODEL() });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "post_only" }, 405);
  let p: any = {};
  try { p = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const missing = SECRETS.filter((k) => !env(k));
  if (p.action === "status") return json({ missing });
  if (!env("FAMILY_CODE")) return json({ error: "setup", missing }, 503);
  if ((req.headers.get("x-family-code") ?? "") !== env("FAMILY_CODE")) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: "wrong_code" }, 401);
  }
  try {
    switch (p.action) {
      case "state": return json({ ...(await loadState()), missing });
      case "test": return await selfTest();
      case "talk": return await talk(p);
      case "options": return await options(p);
      case "pick": return await pick(p);
      case "say": {
        if (!CH[p.character]) return json({ error: "bad_character" }, 400);
        const text = str(p.text, 300); if (!text) return json({ error: "no_text" }, 400);
        return json({ say: text, audio: await tts(p.character, text) });
      }
      case "wish_remove": await db.from("wishes").delete().eq("id", str(p.wishId, 40)); return json(await loadState());
      case "wish_update": {
        const patch: Record<string, unknown> = {};
        if (typeof p.bought === "boolean") patch.bought = p.bought;
        if (typeof p.asin === "string") {
          const a = /^[A-Z0-9]{10}$/.test(p.asin) ? p.asin : "";
          patch.asin = a; if (a) patch.url = `https://www.amazon.com/dp/${a}`;
        }
        if (Object.keys(patch).length) await db.from("wishes").update(patch).eq("id", str(p.wishId, 40));
        return json(await loadState());
      }
      case "kid_add": { const n = str(p.name, 20).trim(); if (n) await db.from("kids").insert({ name: n }); return json(await loadState()); }
      case "kid_rename": { const n = str(p.name, 20).trim(); if (n) await db.from("kids").update({ name: n }).eq("id", str(p.kidId, 40)); return json(await loadState()); }
      case "kid_remove": await db.from("kids").delete().eq("id", str(p.kidId, 40)); return json(await loadState());
      case "voices": return json({ voices: await elVoices(), map: await voiceMap(), characters: Object.fromEntries(Object.entries(CH).map(([k, v]) => [k, v.name])) });
      case "voice_set": {
        if (!CH[p.character]) return json({ error: "bad_character" }, 400);
        const map = await voiceMap(); map[p.character] = str(p.voiceId, 60);
        await db.from("settings").upsert({ key: "voices", value: map, updated_at: new Date().toISOString() });
        return json({ map });
      }
      default: return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    if (e instanceof Upstream) { console.error("upstream", p.action, e.service, e.detail); return json({ error: "upstream", service: e.service, detail: e.detail }, 502); }
    console.error("server", p.action, String(e).slice(0, 300));
    return json({ error: "server", detail: String(e).slice(0, 300) }, 500);
  }
});
