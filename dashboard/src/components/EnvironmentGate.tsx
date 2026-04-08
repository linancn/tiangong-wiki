import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

interface EnvironmentGateProps {
  children: ComponentChildren;
}

const MIN_WIDTH = 1180;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function EnvironmentGate({ children }: EnvironmentGateProps) {
  const [viewportWidth, setViewportWidth] = useState<number>(window.innerWidth);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const hostname = window.location.hostname;
  const localAllowed = LOCAL_HOSTS.has(hostname);
  const desktopAllowed = viewportWidth >= MIN_WIDTH;

  if (localAllowed && desktopAllowed) {
    return <>{children}</>;
  }

  return (
    <div className="env-gate">
      <div className="env-gate__panel">
        <h1>Wiki Intelligence</h1>
        {!localAllowed && (
          <p>
            This dashboard is intentionally localhost-only. Open it from
            <code> http://localhost </code>
            or
            <code> http://127.0.0.1 </code>.
          </p>
        )}
        {!desktopAllowed && (
          <p>
            Desktop viewport required. Current width:
            <code> {viewportWidth}px </code> (minimum <code>{MIN_WIDTH}px</code>).
          </p>
        )}
      </div>
    </div>
  );
}
