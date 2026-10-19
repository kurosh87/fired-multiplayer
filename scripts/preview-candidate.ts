/** Explicit private candidate selection; never registry admission. */
export function previewCandidate() {
  const candidate=process.env.KANTO_PREVIEW_CANDIDATE??(process.env.KANTO_AUDIO_PREVIEW==='1'?'audio-16':'memory-16');
  if(!['memory-16','audio-16','battle-text-audio-16'].includes(candidate))throw new Error('Choose a supported experimental preview candidate.');
  return candidate;
}
