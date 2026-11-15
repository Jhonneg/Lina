import { notFound } from "next/navigation";
import { VoiceBenchmark } from "../../../components/voice/voice-benchmark";

export default function VoiceBenchmarkPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <VoiceBenchmark />;
}
