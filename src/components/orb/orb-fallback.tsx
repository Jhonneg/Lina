import styles from "./orb.module.css";

export function OrbFallback({ unavailable = false }: { unavailable?: boolean }) {
  return (
    <div className={styles.fallback}>
      <svg className={styles.staticOrb} viewBox="0 0 200 200" fill="none" stroke="currentColor" strokeWidth="0.6" aria-hidden="true">
        <g transform="rotate(-12 100 100)" opacity="0.45">
          {[-80, -64, -48, -32, -16, 0, 16, 32, 48, 64, 80].map((offset) => (
            <ellipse key={`latitude-${offset}`} cx="100" cy={100 + offset} rx={Math.sqrt(90 ** 2 - offset ** 2)} ry="13" />
          ))}
          {[12, 27, 43, 58, 72, 84, 90].map((radius) => (
            <ellipse key={`longitude-${radius}`} cx="100" cy="100" rx={radius} ry="90" />
          ))}
        </g>
      </svg>
      <span className={styles.fallbackNote}>{unavailable ? "3D unavailable · static preview" : "Loading 3D presence…"}</span>
    </div>
  );
}
