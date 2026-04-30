const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── PRESETS DE MASTER (BOOSTED) ──────────────────────────────────────
const PRESETS = {
  nd_padrao: {
    comp: 0.30, width: 1.35, limit: 0.20, ceiling: -0.05, release: 1.0,
    bgVol: 0.24, fadeIn: 1.2, fadeOut: 0.6, voicePreset: "nd_padrao",
    masterBoostDb: 4.0,
  },
  varejo: {
    comp: 0.32, width: 1.40, limit: 0.18, ceiling: -0.05, release: 0.9,
    bgVol: 0.26, fadeIn: 1.0, fadeOut: 0.5, voicePreset: "varejo",
    masterBoostDb: 5.0,
  },
  institucional: {
    comp: 0.26, width: 1.30, limit: 0.22, ceiling: -0.05, release: 1.2,
    bgVol: 0.22, fadeIn: 1.5, fadeOut: 0.8, voicePreset: "institucional",
    masterBoostDb: 3.5,
  },
  politica: {
    comp: 0.30, width: 1.35, limit: 0.20, ceiling: -0.05, release: 1.0,
    bgVol: 0.24, fadeIn: 1.2, fadeOut: 0.6, voicePreset: "politica",
    masterBoostDb: 4.5,
  },
  jingle: {
    comp: 0.32, width: 1.40, limit: 0.18, ceiling: -0.05, release: 0.9,
    bgVol: 0.30, fadeIn: 0.5, fadeOut: 0.5, voicePreset: "varejo",
    masterBoostDb: 5.0,
  },
  dialogo: {
    comp: 0.28, width: 1.35, limit: 0.22, ceiling: -0.05, release: 1.1,
    bgVol: 0.22, fadeIn: 1.0, fadeOut: 0.6, voicePreset: "nd_padrao",
    masterBoostDb: 4.0,
  },
  radio_fm_br: {
    comp: 0.34, width: 1.45, limit: 0.16, ceiling: -0.05, release: 0.8,
    bgVol: 0.26, fadeIn: 1.0, fadeOut: 0.5, voicePreset: "radio_fm_br",
    masterBoostDb: 5.5,
  },
};

// ─── PRESETS DE VOZ (loudnorm mais alto) ──────────────────────────────
const VOICE_PRESETS = {
  nd_padrao: {
    highpass: 80, presence: 3000, presenceGain: 3, presenceQ: 1.0,
    compThresh: -18, compRatio: 3, compAttack: 0.005, compRelease: 0.15,
    loudnormI: -12, loudnormLRA: 7, loudnormTP: -0.5,
    volume: 1.0,
  },
  varejo: {
    highpass: 90, presence: 3200, presenceGain: 4, presenceQ: 1.1,
    compThresh: -16, compRatio: 4, compAttack: 0.003, compRelease: 0.12,
    loudnormI: -11, loudnormLRA: 6, loudnormTP: -0.5,
    volume: 1.05,
  },
  institucional: {
    highpass: 80, presence: 2800, presenceGain: 2.5, presenceQ: 0.9,
    compThresh: -19, compRatio: 2.8, compAttack: 0.006, compRelease: 0.18,
    loudnormI: -13, loudnormLRA: 8, loudnormTP: -0.5,
    volume: 0.95,
  },
  politica: {
    highpass: 85, presence: 3000, presenceGain: 3.5, presenceQ: 1.0,
    compThresh: -17, compRatio: 3.5, compAttack: 0.004, compRelease: 0.13,
    loudnormI: -12, loudnormLRA: 7, loudnormTP: -0.5,
    volume: 1.0,
  },
  radio_fm_br: {
    highpass: 90, presence: 3200, presenceGain: 4, presenceQ: 1.1,
    compThresh: -15, compRatio: 4.5, compAttack: 0.003, compRelease: 0.10,
    loudnormI: -10, loudnormLRA: 3, loudnormTP: -0.5,
    volume: 1.1,
  },
};

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function buildVoiceFilter(vp) {
  return [
    `highpass=f=${vp.highpass}`,
    `equalizer=f=${vp.presence}:t=q:w=${vp.presenceQ}:g=${vp.presenceGain}`,
    `acompressor=threshold=${vp.compThresh}dB:ratio=${vp.compRatio}:attack=${Math.round(vp.compAttack * 1000)}:release=${Math.round(vp.compRelease * 1000)}:makeup=2`,
    `loudnorm=I=${vp.loudnormI}:LRA=${vp.loudnormLRA}:TP=${vp.loudnormTP}`,
    `volume=${vp.volume}`,
  ].join(",");
}

function tmpFile(ext = "mp3") {
  return path.join(os.tmpdir(), `${uuidv4()}.${ext}`);
}

async function downloadToTmp(url, ext = "mp3") {
  const out = tmpFile(ext);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(out, buf);
  return out;
}

async function uploadResult(supabase, filePath, orderId, ext = "mp3", contentType = "audio/mpeg") {
  const fileName = `${orderId || uuidv4()}_${Date.now()}.${ext}`;
  const buf = fs.readFileSync(filePath);
  const { error } = await supabase.storage
    .from("order-files")
    .upload(fileName, buf, { contentType, upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("order-files").getPublicUrl(fileName);
  return data.publicUrl;
}

// ─── MIX PADRÃO (voz + trilha) ────────────────────────────────────────
async function processStandardMix(opts) {
  const {
    voiceUrl, bgUrl, preset = "nd_padrao", orderId, supabase,
    bgVolumeDb, bgEndOffset = 0.5, bgVolumeMaxDb = -12,
    bgCompress = true, bgCompressThresholdDb = -18, bgCompressRatio = 4,
  } = opts;

  const p = PRESETS[preset] || PRESETS.nd_padrao;
  const vp = VOICE_PRESETS[p.voicePreset] || VOICE_PRESETS.nd_padrao;

  const voiceFile = await downloadToTmp(voiceUrl);
  const bgFile = bgUrl ? await downloadToTmp(bgUrl) : null;
  const outFile = tmpFile("mp3");

  // BG volume em dB → linear (default do preset se não passado)
  const bgVolLinear = typeof bgVolumeDb === "number" && bgVolumeDb !== -1
    ? Math.pow(10, bgVolumeDb / 20)
    : p.bgVol;

  // Duração da voz
  const voiceDur = parseFloat(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", voiceFile,
  ]).toString().trim());

  const totalDur = voiceDur + p.fadeOut + 0.3;
  const bgEndTime = Math.max(p.fadeIn, voiceDur - bgEndOffset);

  let filter;
  if (bgFile) {
    const bgChain = [
      `volume=${bgVolLinear}`,
      bgCompress
        ? `acompressor=threshold=${bgCompressThresholdDb}dB:ratio=${bgCompressRatio}:attack=10:release=200:makeup=1`
        : null,
      `volume=${Math.pow(10, bgVolumeMaxDb / 20)}:eval=once`,
      `afade=t=in:st=0:d=${p.fadeIn}`,
      `afade=t=out:st=${bgEndTime}:d=${p.fadeOut}`,
      `apad`,
    ].filter(Boolean).join(",");

    filter =
      `[0:a]${buildVoiceFilter(vp)}[v];` +
      `[1:a]aloop=loop=-1:size=2e9,${bgChain}[b];` +
      `[v][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
      `volume=${p.masterBoostDb}dB,` +
      `acompressor=threshold=-14dB:ratio=6:attack=3:release=${Math.round(p.release * 1000)}:makeup=3,` +
      `alimiter=limit=${p.limit}:level=disabled:attack=1:release=50,` +
      `volume=${p.ceiling}dB[mix]`;
  } else {
    filter =
      `[0:a]${buildVoiceFilter(vp)},` +
      `volume=${p.masterBoostDb}dB,` +
      `acompressor=threshold=-14dB:ratio=6:attack=3:release=${Math.round(p.release * 1000)}:makeup=3,` +
      `alimiter=limit=${p.limit}:level=disabled:attack=1:release=50,` +
      `volume=${p.ceiling}dB[mix]`;
  }

  const args = ["-y", "-i", voiceFile];
  if (bgFile) args.push("-i", bgFile);
  args.push(
    "-filter_complex", filter,
    "-map", "[mix]",
    "-t", totalDur.toString(),
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    outFile,
  );

  console.log("[mixer] FFmpeg standard mix:", args.join(" "));
  execFileSync(FFMPEG, args, { stdio: "inherit" });

  const url = await uploadResult(supabase, outFile, orderId);
  try { fs.unlinkSync(voiceFile); } catch {}
  if (bgFile) try { fs.unlinkSync(bgFile); } catch {}
  try { fs.unlinkSync(outFile); } catch {}
  return url;
}

// ─── MIX COM JINGLE (sidechain ducking) ───────────────────────────────
async function processJingleMix(opts) {
  const {
    voiceUrl, jingleUrl, preset = "jingle", orderId, supabase,
    jingleVoiceStart = 3, jingleEndTime,
  } = opts;

  const p = PRESETS[preset] || PRESETS.jingle;
  const vp = VOICE_PRESETS[p.voicePreset] || VOICE_PRESETS.varejo;

  const voiceFile = await downloadToTmp(voiceUrl);
  const jingleFile = await downloadToTmp(jingleUrl);
  const outFile = tmpFile("mp3");

  const voiceDur = parseFloat(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", voiceFile,
  ]).toString().trim());

  const jingleDur = parseFloat(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", jingleFile,
  ]).toString().trim());

  const totalDur = Math.max(jingleDur, jingleVoiceStart + voiceDur + 1);

  // Voz começa em jingleVoiceStart; jingle abaixa 75% durante voz
  const filter =
    `[0:a]${buildVoiceFilter(vp)},adelay=${Math.round(jingleVoiceStart * 1000)}|${Math.round(jingleVoiceStart * 1000)}[v];` +
    `[1:a]volume=1.0[j];` +
    `[j][v]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400:makeup=1[ducked];` +
    `[ducked][v]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,` +
    `volume=${p.masterBoostDb}dB,` +
    `acompressor=threshold=-14dB:ratio=6:attack=3:release=${Math.round(p.release * 1000)}:makeup=3,` +
    `alimiter=limit=${p.limit}:level=disabled:attack=1:release=50,` +
    `volume=${p.ceiling}dB[mix]`;

  const args = [
    "-y", "-i", voiceFile, "-i", jingleFile,
    "-filter_complex", filter,
    "-map", "[mix]",
    "-t", totalDur.toString(),
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    outFile,
  ];

  console.log("[mixer] FFmpeg jingle mix:", args.join(" "));
  execFileSync(FFMPEG, args, { stdio: "inherit" });

  const url = await uploadResult(supabase, outFile, orderId);
  try { fs.unlinkSync(voiceFile); } catch {}
  try { fs.unlinkSync(jingleFile); } catch {}
  try { fs.unlinkSync(outFile); } catch {}
  return url;
}

// ─── VOZ PURA (sem trilha) ────────────────────────────────────────────
async function processVoiceOnly(opts) {
  const { voiceUrl, preset = "nd_padrao", orderId, supabase } = opts;
  const p = PRESETS[preset] || PRESETS.nd_padrao;
  const vp = VOICE_PRESETS[p.voicePreset] || VOICE_PRESETS.nd_padrao;

  const voiceFile = await downloadToTmp(voiceUrl);
  const outFile = tmpFile("mp3");

  const filter =
    `[0:a]${buildVoiceFilter(vp)},` +
    `volume=${p.masterBoostDb}dB,` +
    `acompressor=threshold=-14dB:ratio=6:attack=3:release=${Math.round(p.release * 1000)}:makeup=3,` +
    `alimiter=limit=${p.limit}:level=disabled:attack=1:release=50,` +
    `volume=${p.ceiling}dB[mix]`;

  const args = [
    "-y", "-i", voiceFile,
    "-filter_complex", filter,
    "-map", "[mix]",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    outFile,
  ];

  console.log("[mixer] FFmpeg voice-only:", args.join(" "));
  execFileSync(FFMPEG, args, { stdio: "inherit" });

  const url = await uploadResult(supabase, outFile, orderId);
  try { fs.unlinkSync(voiceFile); } catch {}
  try { fs.unlinkSync(outFile); } catch {}
  return url;
}

// ─── CLEAN TAKE (limpeza de cortes) ───────────────────────────────────
async function cleanTake(opts) {
  const { voiceUrl, cuts = [], orderId, supabase } = opts;
  const voiceFile = await downloadToTmp(voiceUrl);
  const outFile = tmpFile("mp3");

  const cutsArr = Array.isArray(cuts) ? cuts : [];
  let filter;
  if (cutsArr.length === 0) {
    filter = `[0:a]highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=150:makeup=2,loudnorm=I=-14:LRA=7:TP=-0.5,volume=1.0[out]`;
  } else {
    const segments = [];
    let lastEnd = 0;
    cutsArr.forEach((c, i) => {
      segments.push(`[0:a]atrim=${lastEnd}:${c.start},asetpts=PTS-STARTPTS[s${i}]`);
      lastEnd = c.end;
    });
    segments.push(`[0:a]atrim=start=${lastEnd},asetpts=PTS-STARTPTS[s${cutsArr.length}]`);
    const concatInputs = segments.map((_, i) => `[s${i}]`).join("");
    filter = `${segments.join(";")};${concatInputs}concat=n=${segments.length}:v=0:a=1[joined];` +
      `[joined]highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=150:makeup=2,loudnorm=I=-14:LRA=7:TP=-0.5,volume=1.0[out]`;
  }

  const args = [
    "-y", "-i", voiceFile,
    "-filter_complex", filter,
    "-map", "[out]",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    outFile,
  ];

  execFileSync(FFMPEG, args, { stdio: "inherit" });

  const url = await uploadResult(supabase, outFile, orderId, "mp3", "audio/mpeg");
  try { fs.unlinkSync(voiceFile); } catch {}
  try { fs.unlinkSync(outFile); } catch {}
  return url;
}

// ─── Entrada principal ────────────────────────────────────────────────
async function mixAudio(opts) {
  if (opts.voiceOnly) return processVoiceOnly(opts);
  if (opts.jingleUrl) return processJingleMix(opts);
  return processStandardMix(opts);
}

module.exports = {
  mixAudio,
  cleanTake,
  VOICE_PRESETS,
  PRESETS,
};
