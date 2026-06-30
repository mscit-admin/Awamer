/**
 * Branding admin page (admin / super_admin).
 * Set the instance app name and logo; persisted on the server for everyone.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Palette, Loader2, AlertCircle, CheckCircle2, Upload, Trash2 } from "lucide-react";
import { brandingApi } from "./brandingApi";
import { useBranding } from "@/shared/branding";
import { ApiError } from "@/shared/lib/api";

const MAX_BYTES = 500 * 1024; // ~500 KB for logo/favicon
const MAX_LOGIN_BYTES = 2.5 * 1024 * 1024; // larger budget for the login background

export function BrandingPage() {
  const apply = useBranding((s) => s.apply);
  const [name, setName] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [favicon, setFavicon] = useState<string | null>(null);
  const [loginImage, setLoginImage] = useState<string | null>(null);
  const [terminalWatermark, setTerminalWatermark] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const faviconRef = useRef<HTMLInputElement | null>(null);
  const loginRef = useRef<HTMLInputElement | null>(null);
  const watermarkRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    brandingApi.get()
      .then((b) => { setName(b.app_name ?? ""); setLogo(b.logo ?? null); setFavicon(b.favicon ?? null); setLoginImage(b.login_image ?? null); setTerminalWatermark(b.terminal_watermark ?? null); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function readImage(file: File | undefined, set: (v: string) => void, max = MAX_BYTES) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Please choose an image file."); return; }
    if (file.size > max) { setError(`Image too large (max ${Math.round(max / 1024)} KB).`); return; }
    const reader = new FileReader();
    reader.onload = () => { set(reader.result as string); setError(null); };
    reader.readAsDataURL(file);
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    readImage(file, setLogo);
  }

  function onPickFavicon(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    readImage(file, setFavicon);
  }

  function onPickLogin(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    readImage(file, setLoginImage, MAX_LOGIN_BYTES);
  }

  function onPickWatermark(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    readImage(file, setTerminalWatermark, MAX_LOGIN_BYTES);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const b = await brandingApi.update({ app_name: name.trim() || null, logo, favicon, login_image: loginImage, terminal_watermark: terminalWatermark });
      apply({ app_name: b.app_name, logo: b.logo, favicon: b.favicon, login_image: b.login_image, terminal_watermark: b.terminal_watermark });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <Palette className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Branding</h1>
          <p className="text-sm text-fg-muted mt-0.5">App name and logo, shown to everyone.</p>
        </div>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <form onSubmit={save} className="card p-5 space-y-5">
          <div>
            <label className="block text-xs text-fg-muted mb-1">App name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Awamer" className="input w-full" />
            <p className="text-2xs text-fg-muted mt-1">
              Also shown as the issuer name at the top of the entry in authenticator apps (Google Authenticator,
              etc.) when users set up two-factor authentication. Defaults to <span className="font-medium">Awamer</span>.
              Changing it affects <span className="font-medium">new</span> 2FA enrollments only.
            </p>
          </div>

          <div>
            <label className="block text-xs text-fg-muted mb-2">Logo</label>
            <div className="flex items-center gap-4">
              <div className="size-16 rounded-md bg-bg-elevated border border-border grid place-items-center overflow-hidden">
                {logo ? <img src={logo} alt="logo preview" className="size-full object-contain" /> : <Palette className="size-6 text-fg-subtle" />}
              </div>
              <div className="flex flex-col gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className="btn-ghost text-xs">
                  <Upload className="size-3.5" /> Upload image
                </button>
                {logo && (
                  <button type="button" onClick={() => setLogo(null)} className="btn-ghost text-xs text-red-400">
                    <Trash2 className="size-3.5" /> Remove
                  </button>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
            </div>
            <p className="text-2xs text-fg-muted mt-2">PNG/SVG/JPG, up to {Math.round(MAX_BYTES / 1024)} KB. Square images look best.</p>
          </div>

          <div>
            <label className="block text-xs text-fg-muted mb-2">Favicon (browser tab icon)</label>
            <div className="flex items-center gap-4">
              <div className="size-10 rounded bg-bg-elevated border border-border grid place-items-center overflow-hidden">
                {favicon ? <img src={favicon} alt="favicon preview" className="size-full object-contain" /> : <Palette className="size-4 text-fg-subtle" />}
              </div>
              <div className="flex flex-col gap-2">
                <button type="button" onClick={() => faviconRef.current?.click()} className="btn-ghost text-xs">
                  <Upload className="size-3.5" /> Upload favicon
                </button>
                {favicon && (
                  <button type="button" onClick={() => setFavicon(null)} className="btn-ghost text-xs text-red-400">
                    <Trash2 className="size-3.5" /> Remove
                  </button>
                )}
              </div>
              <input ref={faviconRef} type="file" accept="image/*,.ico" hidden onChange={onPickFavicon} />
            </div>
            <p className="text-2xs text-fg-muted mt-2">Small square icon (PNG/SVG/ICO). Leave empty to use the default.</p>
          </div>

          <div>
            <label className="block text-xs text-fg-muted mb-2">Login background image</label>
            <div className="rounded-md border border-border bg-bg-elevated overflow-hidden mb-2 aspect-[16/7] grid place-items-center">
              {loginImage
                ? <img src={loginImage} alt="login background preview" className="size-full object-cover" />
                : <span className="text-2xs text-fg-subtle">No image — plain background</span>}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => loginRef.current?.click()} className="btn-ghost text-xs">
                <Upload className="size-3.5" /> Upload image
              </button>
              {loginImage && (
                <button type="button" onClick={() => setLoginImage(null)} className="btn-ghost text-xs text-red-400">
                  <Trash2 className="size-3.5" /> Remove
                </button>
              )}
              <input ref={loginRef} type="file" accept="image/*" hidden onChange={onPickLogin} />
            </div>
            <p className="text-2xs text-fg-muted mt-2">Shown behind the sign-in card (landscape, up to {Math.round(MAX_LOGIN_BYTES / 1024 / 1024 * 10) / 10} MB).</p>
          </div>

          <div>
            <label className="block text-xs text-fg-muted mb-2">Terminal watermark</label>
            <div className="rounded-md border border-border bg-[#0b0e14] overflow-hidden mb-2 aspect-[16/7] grid place-items-center">
              {terminalWatermark
                ? <img src={terminalWatermark} alt="terminal watermark preview" className="max-w-[45%] max-h-[70%] object-contain opacity-[0.18]" />
                : <span className="text-2xs text-fg-subtle">No image — shows the logo, or the username</span>}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => watermarkRef.current?.click()} className="btn-ghost text-xs">
                <Upload className="size-3.5" /> Upload image
              </button>
              {terminalWatermark && (
                <button type="button" onClick={() => setTerminalWatermark(null)} className="btn-ghost text-xs text-red-400">
                  <Trash2 className="size-3.5" /> Remove
                </button>
              )}
              <input ref={watermarkRef} type="file" accept="image/*" hidden onChange={onPickWatermark} />
            </div>
            <p className="text-2xs text-fg-muted mt-2">
              Faint image shown in the centre of the terminal background. If empty, the logo is used; if there's no
              logo either, the username is shown. Up to {Math.round(MAX_LOGIN_BYTES / 1024 / 1024 * 10) / 10} MB.
            </p>
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
              <AlertCircle className="size-3.5" /> {error}
            </div>
          )}
          {saved && (
            <div className="px-3 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs rounded flex items-center gap-2">
              <CheckCircle2 className="size-3.5" /> Saved.
            </div>
          )}

          <div className="flex justify-end">
            <button type="submit" disabled={busy} className="btn-primary">
              {busy ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : "Save branding"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
