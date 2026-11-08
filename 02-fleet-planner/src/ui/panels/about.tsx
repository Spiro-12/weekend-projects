// About & credits (Track D). A small "i" button in a corner opens a card with what this is and every credit:
// the NVIDIA SimReady line (exact text from CREDITS.md), each shipped model's credit from the asset manifest, and the
// Quaternius line. CC BY 4.0 requires this wherever the assets ship. Slot `overlay`: the panel places its own button
// and card (position: absolute); the section never blocks clicks.
import { useEffect, useState } from 'preact/hooks';
import type { Host } from '../../host/index.ts';
import type { Manifest } from '../../render/core/assets.ts';
import { definePanel } from '../panel.ts';

/** The NVIDIA line from CREDITS.md, split into text, bold and link pieces (its text content equals the file's). */
type Piece = string | { b: string } | { a: string };
export const NVIDIA_CREDIT: Piece[] = [
  '3D models from ',
  { b: 'NVIDIA SimReady Assets' },
  ' by NVIDIA Corporation (',
  { a: 'https://huggingface.co/datasets/nvidia/simready-assets' },
  '), licensed under ',
  { b: 'CC BY 4.0' },
  ' (',
  { a: 'https://creativecommons.org/licenses/by/4.0/' },
  '). Web conversions from ',
  { b: 'SimReady GLB' },
  ' by codepawl (',
  { a: 'https://huggingface.co/datasets/codepawl/simready-glb' },
  '), CC BY 4.0. ',
  { b: 'Modified' },
  ' for Fleet Planner: re-compressed, simplified, textures resized and re-encoded, pivots and materials adjusted. Provided "as is" without warranties, see the license. NVIDIA and SimReady are trademarks of NVIDIA Corporation; Fleet Planner is not affiliated with or endorsed by NVIDIA.',
];

const CSS = `
.fp-about-btn { position: absolute; left: 14px; bottom: 14px; width: 30px; height: 30px; padding: 0; border-radius: 50%;
  font: 600 15px/28px Georgia, 'Times New Roman', serif; font-style: italic; text-align: center; color: var(--text);
  background: var(--panel); border: 1px solid var(--line); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.fp-about-btn:hover { background: rgba(40,46,58,.9); }
#ui:has(.perf) .fp-about-btn { bottom: 150px; }
.fp-about { position: absolute; left: 14px; bottom: 52px; width: min(440px, calc(100vw - 28px)); max-height: min(72vh, 640px);
  overflow: auto; padding: 16px 18px; font-size: 12.5px; line-height: 1.5; color: var(--text); }
.fp-about h2 { font-size: 15px; margin: 0 0 6px; }
.fp-about h3 { font-size: 11px; margin: 14px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .6px; }
.fp-about p { margin: 0 0 8px; }
.fp-about a { color: var(--cyan); word-break: break-all; }
.fp-about ul { margin: 0; padding-left: 16px; }
.fp-about li { margin: 0 0 6px; }
.fp-about .k { color: var(--accent); font-family: var(--mono); font-size: 11px; }
.fp-about .muted { color: var(--muted); }
.fp-about .close { position: sticky; top: 0; float: right; margin: -6px -8px 0 0; padding: 2px 9px; }
@media (max-width: 760px), (pointer: coarse) and (max-height: 520px) {
  .fp-about-btn { left: auto; right: 12px; bottom: auto; top: 12px; width: 28px; height: 28px; line-height: 26px; }
  .fp-about { left: 10px; right: 10px; width: auto; bottom: auto; top: 48px; max-height: calc(100% - 120px); }
}`;

function Credit({ pieces }: { pieces: Piece[] }) {
  return (
    <p data-testid="about-nvidia">
      {pieces.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : 'b' in p ? (
          <b key={i}>{p.b}</b>
        ) : (
          <a key={i} href={p.a} target="_blank" rel="noopener noreferrer">
            {p.a}
          </a>
        ),
      )}
    </p>
  );
}

/** Credits name sources as "… (https://…)"; turn those URLs into links. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return <>{parts.map((s, i) => (i % 2 ? <a key={i} href={s} target="_blank" rel="noopener noreferrer">{s}</a> : s))}</>;
}

function About({ host }: { host: Host }) {
  void host;
  const [open, setOpen] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open || manifest) return;
    // Lazy: the shared loader (and its GLTFLoader) is not needed for the first view.
    import('../../render/core/assets.ts')
      .then((m) => m.assetLoader(import.meta.env.BASE_URL).manifest())
      .then(setManifest, () => setError(true));
  }, [open, manifest]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);
  const models = manifest ? Object.entries(manifest.models) : [];
  const simready = models.filter(([, m]) => m.license === 'CC-BY-4.0');
  const other = models.filter(([, m]) => m.license !== 'CC-BY-4.0');
  return (
    <>
      <style>{CSS}</style>
      <button
        class="fp-about-btn"
        data-testid="about-button"
        aria-label="About and credits"
        title="About & credits"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        i
      </button>
      {open && (
        <div class="card fp-about" role="dialog" aria-label="About and credits" data-testid="about-card">
          <button class="close" aria-label="Close" onClick={() => setOpen(false)}>
            ×
          </button>
          <h2>About Fleet Planner</h2>
          <p>
            A warehouse simulator in your browser. Pick a mix of robots and people, watch them pick, pack and ship orders,
            and see what the fleet costs and when it pays back. Robots, numbers and vendors are generic and every input
            cites its source; nothing here is a product endorsement.
          </p>
          <h3>3D models</h3>
          <Credit pieces={NVIDIA_CREDIT} />
          {!manifest && !error && <p class="muted">Loading the model list…</p>}
          {error && <p class="muted">The model list could not be loaded. See CREDITS.md in the project repository.</p>}
          {simready.length > 0 && (
            <ul data-testid="about-models">
              {simready.map(([key, m]) => (
                <li key={key} data-testid={`about-credit-${key}`}>
                  <b>{m.label}</b> <span class="k">{key}</span>
                  <br />
                  <span class="muted">
                    <Linked text={m.credit} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3>Characters</h3>
          {other.length > 0 && (
            <ul>
              {other.map(([key, m]) => (
                <li key={key} data-testid={`about-credit-${key}`}>
                  <b>{m.label}</b> <span class="k">{key}</span>
                  <br />
                  <span class="muted">
                    <Linked text={m.credit} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p data-testid="about-quaternius">
            "Universal Base Characters" and "Universal Animation Library" by <b>Quaternius</b> (
            <a href="https://quaternius.com" target="_blank" rel="noopener noreferrer">
              https://quaternius.com
            </a>
            ), <b>CC0 1.0</b> (
            <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener noreferrer">
              https://creativecommons.org/publicdomain/zero/1.0/
            </a>
            ). Modified: work clothes painted on, animations retargeted, re-compressed.
          </p>
          <h3>Built in code</h3>
          <p>
            The building, racks, floor markings, cart robots, the humanoid robot and the autonomous-forklift sensor kit
            are our own geometry, with no third-party assets or brands.
          </p>
          <h3>Licenses</h3>
          <p>
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">
              Creative Commons Attribution 4.0 (CC BY 4.0)
            </a>
            {' · '}
            <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener noreferrer">
              CC0 1.0
            </a>
            {manifest && (
              <span class="muted">
                {' '}
                · source revision {manifest.source.codepawlRev?.slice(0, 10)}
              </span>
            )}
          </p>
        </div>
      )}
    </>
  );
}

export default definePanel({ id: 'about', slot: 'overlay', order: 90, title: 'About & credits', Component: About });
