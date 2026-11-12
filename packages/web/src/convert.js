'use strict';

// Conversor de vídeo no navegador: qualquer vídeo que o navegador consiga decodificar (por exemplo HEVC/H.265
// do iPhone) vira H.264 + AAC em MP4, o formato que o Player reproduz. Usa WebCodecs (codificação por hardware
// quando disponível) via mediabunny. Nada é enviado a servidor: a conversão acontece neste computador.

const { Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, ALL_FORMATS, QUALITY_MEDIUM, canEncodeVideo } = require('mediabunny');

const MAX_LONG = 1920; // lado maior (Full HD)
const MAX_SHORT = 1080; // lado menor
const MAX_FPS = 30;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Tamanho de saída: mantém a proporção e cabe em 1920x1080 (ou 1080x1920 se for vertical). */
function targetSize(w, h) {
  const scale = Math.min(1, MAX_LONG / Math.max(w, h), MAX_SHORT / Math.min(w, h));
  return { width: even(w * scale), height: even(h * scale), scaled: scale < 1 };
}

const REASONS = {
  undecodable_source_codec: 'este navegador não consegue decodificar o vídeo (HEVC pede Chrome ou Edge com suporte no computador). Converta em outro programa (HandBrake) e envie o MP4',
  no_encodable_target_codec: 'este navegador não consegue gerar H.264. Use o Chrome ou o Edge atualizado',
  unknown_source_codec: 'formato de vídeo desconhecido',
};

/**
 * Lê só o cabecalho do video e diz se ele passa do que uma TV/totem simples decodifica sem engasgar
 * (acima de Full HD ou acima de 30 fps). Videos dentro do limite nao sao tocados (sem perda de qualidade).
 * @returns {Promise<null | {width:number,height:number,fps:number|null,heavy:boolean,why:string}>}
 */
async function analyzeVideo(file) {
  let input;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const width = track.displayWidth;
    const height = track.displayHeight;
    let fps = null;
    try {
      fps = (await track.computePacketStats(120)).averagePacketRate;
    } catch {
      /* sem a estatistica, julga so pela resolucao */
    }
    return { width, height, fps, ...judgeVideo(width, height, fps) };
  } catch {
    return null;
  } finally {
    input?.dispose?.();
  }
}

/** Regra pura (testavel): precisa otimizar quando passa de Full HD ou de 30 fps. */
function judgeVideo(width, height, fps) {
  const big = Math.max(width, height) > MAX_LONG || Math.min(width, height) > MAX_SHORT;
  const fast = typeof fps === 'number' && fps > MAX_FPS + 1;
  const why = [big ? `${width}x${height}` : '', fast ? `${Math.round(fps)} fps` : ''].filter(Boolean).join(' e ');
  return { heavy: big || fast, why };
}

/**
 * @param {File} file
 * @param {{ onProgress?: (fraction:number)=>void }} [opts]
 * @returns {Promise<File>} MP4 H.264/AAC com o mesmo nome e extensão .mp4
 */
async function convertVideo(file, { onProgress } = {}) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error('este navegador não tem WebCodecs; use o Chrome ou o Edge atualizado');
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('o arquivo não tem faixa de vídeo');
    if (!(await track.canDecode())) throw new Error(REASONS.undecodable_source_codec);

    const { width, height } = targetSize(track.displayWidth, track.displayHeight);
    if (!(await canEncodeVideo('avc', { width, height }))) throw new Error(REASONS.no_encodable_target_codec);

    // Limita a 30 fps (vídeos de celular vêm em 60) para arquivo menor e decodificação leve na TV.
    let frameRate;
    try {
      const stats = await track.computePacketStats(120);
      if (stats.averagePacketRate > MAX_FPS + 1) frameRate = MAX_FPS;
    } catch {
      /* sem a estatística, mantém o fps original */
    }

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      video: { codec: 'avc', width, height, fit: 'contain', ...(frameRate ? { frameRate } : {}), quality: QUALITY_MEDIUM },
      audio: { codec: 'aac' },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map((d) => REASONS[d.reason] || d.reason).join('; ');
      throw new Error(why || 'não foi possível converter este vídeo');
    }
    if (onProgress) conversion.onProgress = (p) => onProgress(Math.min(1, p));
    await conversion.execute();

    const name = file.name.replace(/\.[^.]*$/, '') + '.mp4';
    return new File([output.target.buffer], name, { type: 'video/mp4' });
  } finally {
    input.dispose?.();
  }
}

module.exports = { convertVideo, analyzeVideo, judgeVideo, targetSize };
