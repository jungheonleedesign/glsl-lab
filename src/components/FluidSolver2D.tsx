"use client";

import { useFBO } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────
// 2D 비압축 유체 솔버 (Stam, Stable Fluids)
// 매 프레임: 이류 → 힘 → 발산 → 압력(Jacobi) → 기울기빼기 → 물색이류 → 표시
// 좌표/속도 규약은 PavelDoGreat 방식(격자 간격 1, halfrdx=0.5).
// ─────────────────────────────────────────────────────────

const SIM_RES = 256;
const PRESSURE_ITER = 30;

// 모든 패스가 쓰는 풀스크린 쿼드 정점셰이더 (카메라 무시)
const baseVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ① 이류: 속도를 거슬러 올라가 source 값을 끌어옴 (semi-Lagrangian)
const advectFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 uTexel;
  uniform float uDt;
  uniform float uDissipation;
  varying vec2 vUv;
  void main() {
    vec2 vel = texture2D(uVelocity, vUv).xy;
    vec2 coord = vUv - uDt * vel * uTexel;   // 한 프레임 전 위치
    gl_FragColor = uDissipation * texture2D(uSource, coord);
  }
`;

// ② splat: 마우스 위치에 가우시안 블롭을 더함 (속도 또는 색)
const splatFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uTarget;
  uniform vec3 uColor;      // 더할 값 (속도면 xy, 색이면 rgb)
  uniform vec2 uPoint;      // 마우스 위치 (uv)
  uniform float uRadius;
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - uPoint;
    float blob = exp(-dot(d, d) / uRadius);
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + blob * uColor, 1.0);
  }
`;

// ③ 발산: div(v) = 0.5*( vR.x - vL.x + vT.y - vB.y )
const divergenceFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uVelocity;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
    float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`;

// ④ Jacobi 한 번: p = (pL + pR + pB + pT - div) / 4
const jacobiFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
    float div = texture2D(uDivergence, vUv).x;
    float p = (L + R + B + T - div) * 0.25;
    gl_FragColor = vec4(p, 0.0, 0.0, 1.0);
  }
`;

// ⑤ 기울기 빼기: v = v - 0.5*∇p,  + 벽에서 속도 0 (담아두기)
const gradientFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
    vec2 vel = texture2D(uVelocity, vUv).xy;
    vel -= 0.5 * vec2(R - L, T - B);

    // 벽: 가장자리 한 칸은 속도 0 (유체가 못 빠져나감)
    if (vUv.x < uTexel.x || vUv.x > 1.0 - uTexel.x ||
        vUv.y < uTexel.y || vUv.y > 1.0 - uTexel.y) {
      vel = vec2(0.0);
    }
    gl_FragColor = vec4(vel, 0.0, 1.0);
  }
`;

// ⑦ 표시: 물색을 화면에
const displayFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uDye;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(uDye, vUv).rgb;
    gl_FragColor = vec4(c, 1.0);
  }
`;

function useDoubleFBO(opts: THREE.RenderTargetOptions) {
  const a = useFBO(SIM_RES, SIM_RES, opts);
  const b = useFBO(SIM_RES, SIM_RES, opts);
  return useRef({ read: a, write: b });
}

export default function FluidSolver2D() {
  const { gl } = useThree();

  const opts = useMemo<THREE.RenderTargetOptions>(
    () => ({
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
    }),
    []
  );

  const velocity = useDoubleFBO(opts);
  const pressure = useDoubleFBO(opts);
  const dye = useDoubleFBO(opts);
  const divergence = useFBO(SIM_RES, SIM_RES, opts);

  // 오프스크린 장면: 쿼드 하나에 패스마다 머티리얼을 갈아끼움
  const scene = useMemo(() => new THREE.Scene(), []);
  const camera = useMemo(() => new THREE.Camera(), []);
  const quad = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    return m;
  }, []);
  useMemo(() => scene.add(quad), [scene, quad]);

  const mats = useMemo(() => {
    const make = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: baseVert, fragmentShader: frag, uniforms });
    const texel = new THREE.Vector2(1 / SIM_RES, 1 / SIM_RES);
    return {
      advect: make(advectFrag, {
        uVelocity: { value: null }, uSource: { value: null },
        uTexel: { value: texel }, uDt: { value: 0 }, uDissipation: { value: 1 },
      }),
      splat: make(splatFrag, {
        uTarget: { value: null }, uColor: { value: new THREE.Vector3() },
        uPoint: { value: new THREE.Vector2() }, uRadius: { value: 0.0005 },
      }),
      divergence: make(divergenceFrag, { uVelocity: { value: null }, uTexel: { value: texel } }),
      jacobi: make(jacobiFrag, {
        uPressure: { value: null }, uDivergence: { value: null }, uTexel: { value: texel },
      }),
      gradient: make(gradientFrag, {
        uPressure: { value: null }, uVelocity: { value: null }, uTexel: { value: texel },
      }),
    };
  }, []);

  const displayRef = useRef<THREE.ShaderMaterial>(null);

  // 패스 실행 헬퍼: 머티리얼을 쿼드에 끼우고 target에 렌더
  const blit = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
  };

  const prevPoint = useRef(new THREE.Vector2(-1, -1));
  const initialized = useRef(false);

  useFrame(({ pointer, clock }) => {
    if (!initialized.current) {
      [velocity.current, pressure.current, dye.current].forEach((d) => {
        gl.setRenderTarget(d.read); gl.clear();
        gl.setRenderTarget(d.write); gl.clear();
      });
      gl.setRenderTarget(divergence); gl.clear();
      gl.setRenderTarget(null);
      initialized.current = true;
    }

    const dt = 0.016;
    const m = mats;

    // ① 속도 이류 (자기 자신을 따라 흐름, 약간 소산)
    m.advect.uniforms.uVelocity.value = velocity.current.read.texture;
    m.advect.uniforms.uSource.value = velocity.current.read.texture;
    m.advect.uniforms.uDt.value = dt;
    m.advect.uniforms.uDissipation.value = 0.999;
    blit(m.advect, velocity.current.write);
    [velocity.current.read, velocity.current.write] = [velocity.current.write, velocity.current.read];

    // ② 마우스 힘 + 색 주입 (커서가 움직일 때만)
    const px = pointer.x * 0.5 + 0.5;
    const py = pointer.y * 0.5 + 0.5;
    const dx = px - prevPoint.current.x;
    const dy = py - prevPoint.current.y;
    const moved = prevPoint.current.x >= 0 && (Math.abs(dx) + Math.abs(dy)) > 0.0001;
    prevPoint.current.set(px, py);

    if (moved) {
      // 속도 splat: 마우스 이동을 힘으로
      m.splat.uniforms.uTarget.value = velocity.current.read.texture;
      m.splat.uniforms.uPoint.value.set(px, py);
      m.splat.uniforms.uColor.value.set(dx * 8000, dy * 8000, 0);
      m.splat.uniforms.uRadius.value = 0.0008;
      blit(m.splat, velocity.current.write);
      [velocity.current.read, velocity.current.write] = [velocity.current.write, velocity.current.read];

      // 색 splat: 시간에 따라 색이 바뀌는 잉크
      const t = clock.elapsedTime;
      m.splat.uniforms.uTarget.value = dye.current.read.texture;
      m.splat.uniforms.uColor.value.set(
        Math.sin(t * 0.7) * 0.5 + 0.5,
        Math.sin(t * 0.9 + 2.0) * 0.5 + 0.5,
        Math.sin(t * 1.1 + 4.0) * 0.5 + 0.5
      );
      m.splat.uniforms.uRadius.value = 0.0008;
      blit(m.splat, dye.current.write);
      [dye.current.read, dye.current.write] = [dye.current.write, dye.current.read];
    }

    // ③ 발산 계산
    m.divergence.uniforms.uVelocity.value = velocity.current.read.texture;
    blit(m.divergence, divergence);

    // ④ 압력 Jacobi 반복 (압력 투영의 심장)
    // 압력 버퍼를 0에서 시작하지 않고 직전 값을 재활용하면 더 빨리 수렴
    for (let i = 0; i < PRESSURE_ITER; i++) {
      m.jacobi.uniforms.uPressure.value = pressure.current.read.texture;
      m.jacobi.uniforms.uDivergence.value = divergence.texture;
      blit(m.jacobi, pressure.current.write);
      [pressure.current.read, pressure.current.write] = [pressure.current.write, pressure.current.read];
    }

    // ⑤ 기울기 빼기 → 비압축 속도 완성 (+ 벽)
    m.gradient.uniforms.uPressure.value = pressure.current.read.texture;
    m.gradient.uniforms.uVelocity.value = velocity.current.read.texture;
    blit(m.gradient, velocity.current.write);
    [velocity.current.read, velocity.current.write] = [velocity.current.write, velocity.current.read];

    // ⑥ 물색 이류 (깨끗한 속도장 따라)
    m.advect.uniforms.uVelocity.value = velocity.current.read.texture;
    m.advect.uniforms.uSource.value = dye.current.read.texture;
    m.advect.uniforms.uDissipation.value = 0.995;
    blit(m.advect, dye.current.write);
    [dye.current.read, dye.current.write] = [dye.current.write, dye.current.read];

    // ⑦ 표시
    if (displayRef.current) {
      displayRef.current.uniforms.uDye.value = dye.current.read.texture;
    }
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={displayRef}
        vertexShader={baseVert}
        fragmentShader={displayFrag}
        uniforms={{ uDye: { value: null } }}
      />
    </mesh>
  );
}
