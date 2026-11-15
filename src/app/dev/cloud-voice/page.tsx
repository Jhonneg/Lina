import { notFound } from "next/navigation";
import { CloudVoiceLab } from "../../../components/voice/cloud-voice-lab";

export default function CloudVoicePage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <CloudVoiceLab />;
}
