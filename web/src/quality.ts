// Device detection and quality: picks a starting profile from the device
// and GPU, then adapts the terrain detail to the measured frame time.

export interface Profile {
  name: "desktop" | "phone" | "quest" | "software";
  sse: number;        // screen-space error threshold in pixels (higher = coarser)
  imagePx: number;    // size of requested aerial photo tiles
  budgetMB: number;   // GPU memory for terrain geometry and textures
  maxPixelRatio: number;
  targetFps: number;
  antialias: boolean;
  meshStep: number;   // use every n-th height sample for the mesh (1 or 2)
}

const PROFILES: Record<Profile["name"], Profile> = {
  desktop: { name: "desktop", sse: 2.5, imagePx: 512, budgetMB: 300, maxPixelRatio: 2, targetFps: 60, antialias: true, meshStep: 1 },
  phone: { name: "phone", sse: 4, imagePx: 256, budgetMB: 120, maxPixelRatio: 1.5, targetFps: 30, antialias: false, meshStep: 2 },
  quest: { name: "quest", sse: 3, imagePx: 256, budgetMB: 200, maxPixelRatio: 1, targetFps: 72, antialias: true, meshStep: 1 },
  software: { name: "software", sse: 8, imagePx: 256, budgetMB: 80, maxPixelRatio: 1, targetFps: 20, antialias: false, meshStep: 2 },
};

export interface Device {
  gpu: string;
  software: boolean;
  mobile: boolean;
  quest: boolean;
  ar: boolean; // immersive-ar supported (WebXR)
  vr: boolean; // immersive-vr supported (WebXR)
}

const SOFTWARE_GPU = /swiftshader|basic render|llvmpipe|softpipe|software/i;

/** Detect the device with a throwaway WebGL context, before the renderer exists. */
export async function detectDevice(): Promise<Device> {
  const probe = document.createElement("canvas");
  const gl = (probe.getContext("webgl2") ?? probe.getContext("webgl"))!;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const ua = navigator.userAgent;
  const quest = /OculusBrowser|Quest/i.test(ua);
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  const mobile = !quest && (uaData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(ua));
  const xr = (navigator as Navigator & { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
  const supported = async (mode: string) => (xr ? xr.isSessionSupported(mode).catch(() => false) : false);
  const [ar, vr] = await Promise.all([supported("immersive-ar"), supported("immersive-vr")]);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { gpu, software: SOFTWARE_GPU.test(gpu), mobile, quest, ar, vr };
}

/** Starting profile; ?quality=desktop|phone|quest|software overrides it. */
export function pickProfile(d: Device): Profile {
  const forced = new URLSearchParams(location.search).get("quality") as Profile["name"] | null;
  if (forced && forced in PROFILES) return { ...PROFILES[forced] };
  if (d.software) return { ...PROFILES.software };
  if (d.quest) return { ...PROFILES.quest };
  if (d.mobile) return { ...PROFILES.phone };
  return { ...PROFILES.desktop };
}

/**
 * While frames are too slow for the profile's target, first raises the
 * detail threshold (up to 4x the profile's), then lowers the render scale
 * (down to half). With headroom it undoes both in reverse order.
 * Frame intervals are capped by the display, so only slowness is measured.
 */
export class AdaptiveQuality {
  sse: number;
  scale = 1; // render resolution relative to the profile's pixel ratio
  fps = 0;
  private avg = 0;
  private last = 0;
  private lastChange = 0;

  constructor(private profile: Profile) {
    this.sse = profile.sse;
  }

  frame(now: number): void {
    if (this.last) {
      const dt = Math.min(now - this.last, 1000);
      this.avg = this.avg ? this.avg * 0.95 + dt * 0.05 : dt;
      this.fps = 1000 / this.avg;
    }
    this.last = now;
    if (now - this.lastChange < 1000 || !this.avg) return;
    const target = 1000 / this.profile.targetFps;
    const maxSse = this.profile.sse * 4;
    if (this.avg > target * 1.2) {
      if (this.sse < maxSse) this.sse = Math.min(maxSse, this.sse * 1.25);
      else if (this.scale > 0.5) this.scale = Math.max(0.5, this.scale * 0.85);
      else return;
      this.lastChange = now;
    } else if (this.avg < target * 0.9) {
      if (this.scale < 1) this.scale = Math.min(1, this.scale / 0.9);
      else if (this.sse > this.profile.sse) this.sse = Math.max(this.profile.sse, this.sse / 1.1);
      else return;
      this.lastChange = now;
    }
  }
}
