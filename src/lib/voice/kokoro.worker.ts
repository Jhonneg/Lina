import { createKokoroSynthesis } from "./kokoro-synthesis";
import { VoiceError, validateSpeechText, type SynthesisMetrics, type WorkerRequest, type WorkerResponse } from "./types";

const scope = self as unknown as { onmessage: (event: MessageEvent<WorkerRequest>) => void; postMessage: (value: WorkerResponse, transfer?: Transferable[]) => void };
const synthesize = createKokoroSynthesis();
scope.onmessage = async ({ data: { id, text } }) => {
  try {
    validateSpeechText(text);
    let metrics: SynthesisMetrics | undefined;
    const audio = await synthesize(text, progress => scope.postMessage({ id, kind: "progress", progress }), value => { metrics = value; });
    scope.postMessage({ id, kind: "audio", audio, metrics }, [audio]);
  } catch (error) { scope.postMessage({ id, kind: "error", code: error instanceof VoiceError && error.code === "loading" ? "loading" : "generation" }); }
};
