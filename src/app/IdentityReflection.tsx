import { useEffect, useRef, useState } from "react";
import type { MotionValue } from "motion/react";
import fragment from "./identity-reflection.frag?raw";
import styles from "./IdentityBadge.module.css";

/** Pointer-driven badge artwork. The CSS accent tint remains the GPU fallback. */
export function IdentityReflection({
  x,
  y,
  active,
  surface = "accent",
  regions,
}: {
  x: MotionValue<number>;
  y: MotionValue<number>;
  active: boolean;
  surface?: "accent" | "magnetic" | "paper" | "film";
  /** Local artwork bounds when one canvas paints several separate surfaces. */
  regions?: () => readonly {
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Restored contexts need fresh GPU resources.
  useEffect(() => {
    const canvas = ref.current;
    setPainted(false);
    if (!canvas || !active || typeof WebGLRenderingContext === "undefined")
      return;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      // This surface paints on demand and retains its last reflection at rest.
      preserveDrawingBuffer: true,
    });
    if (!gl) return;
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    let frame = 0;
    const release = () => {
      cancelAnimationFrame(frame);
      for (const shader of shaders)
        if (gl.isShader(shader)) gl.deleteShader(shader);
      if (gl.isBuffer(buffer)) gl.deleteBuffer(buffer);
      if (gl.isProgram(program)) gl.deleteProgram(program);
    };
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Reflection shader unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Reflection shader failed");
      return shader;
    };
    try {
      if (!program || !buffer)
        throw new Error("Reflection resources unavailable");
      gl.attachShader(
        program,
        compile(
          gl.VERTEX_SHADER,
          "attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}",
        ),
      );
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("Reflection shader link failed");
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    } catch {
      release();
      return;
    }
    if (!program) return;
    const size = gl.getUniformLocation(program, "u_size");
    const origin = gl.getUniformLocation(program, "u_origin");
    const tilt = gl.getUniformLocation(program, "u_tilt");
    const accent = gl.getUniformLocation(program, "u_accent");
    const magnetic = gl.getUniformLocation(program, "u_magnetic");
    const paper = gl.getUniformLocation(program, "u_paper");
    const film = gl.getUniformLocation(program, "u_film");
    const sample = document.createElement("canvas");
    sample.width = sample.height = 1;
    const color = sample.getContext("2d", { willReadFrequently: true });
    if (!color) {
      release();
      return;
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const forced = matchMedia("(forced-colors: active)");
    const draw = () => {
      frame = 0;
      if (reduced.matches || forced.matches) {
        setPainted(false);
        return;
      }
      if (document.hidden || gl.isContextLost() || !gl.isProgram(program))
        return;
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      color.fillStyle = getComputedStyle(canvas).color;
      color.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = color.getImageData(0, 0, 1, 1).data;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
      gl.useProgram(program);
      gl.uniform2f(tilt, x.get(), -y.get());
      gl.uniform3f(accent, r / 255, g / 255, b / 255);
      gl.uniform1f(magnetic, surface === "magnetic" ? 1 : 0);
      gl.uniform1f(paper, surface === "paper" ? 1 : 0);
      gl.uniform1f(film, surface === "film" ? 1 : 0);
      const surfaces = regions?.() ?? [
        { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight },
      ];
      for (const region of surfaces) {
        const left = Math.round(region.x * ratio);
        const bottom = height - Math.round((region.y + region.height) * ratio);
        const w = Math.max(1, Math.round(region.width * ratio));
        const h = Math.max(1, Math.round(region.height * ratio));
        gl.viewport(left, bottom, w, h);
        gl.uniform2f(size, w, h);
        gl.uniform2f(origin, left, bottom);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      setPainted(true);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(frame);
      frame = 0;
      setPainted(false);
    };
    const restored = () => setRevision((value) => value + 1);
    const offX = x.on("change", schedule);
    const offY = y.on("change", schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(canvas);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-accent", "data-color-mode", "data-color-level"],
    });
    document.addEventListener("visibilitychange", schedule);
    reduced.addEventListener("change", schedule);
    forced.addEventListener("change", schedule);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    schedule();
    return () => {
      offX();
      offY();
      resize.disconnect();
      theme.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      reduced.removeEventListener("change", schedule);
      forced.removeEventListener("change", schedule);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      release();
    };
  }, [active, x, y, revision, surface, regions]);
  return (
    <canvas
      ref={ref}
      className={styles.reflection}
      data-identity-reflection={surface}
      aria-hidden="true"
      tabIndex={-1}
      style={{ visibility: painted && active ? "visible" : "hidden" }}
    />
  );
}
