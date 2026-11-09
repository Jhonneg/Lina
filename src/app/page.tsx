import { OrbDemo } from "@/components/orb/orb-demo";

export default function Home() {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-5xl flex-col px-6 sm:px-12">
      <header className="flex items-center justify-between py-7 sm:py-10">
        <span className="text-sm font-medium tracking-[0.22em]">LAIN <span className="text-gold">2.0</span></span>
        <span className="text-xs text-cream/60">A space to pause.</span>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center pb-12 pt-6 sm:pb-20">
        <OrbDemo />
        <div className="mt-10 w-full max-w-lg sm:mt-14">
          <label htmlFor="message" className="sr-only">Message (preview only)</label>
          <input id="message" type="text" disabled placeholder="A conversation begins here…" aria-describedby="composer-note"
            className="w-full rounded-2xl border border-gold/20 bg-cream/[0.02] px-5 py-4 text-sm text-cream placeholder:text-cream/45 disabled:cursor-not-allowed" />
          <p id="composer-note" className="mt-3 text-center text-xs text-cream/55">Visual preview · messaging isn’t connected yet.</p>
        </div>
      </main>
      <footer className="pb-6 text-center text-[10px] tracking-[0.16em] text-gold/70">A LITTLE PRESENCE. A LITTLE STILLNESS.</footer>
    </div>
  );
}
