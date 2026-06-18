"use client";

import { OrbitControls, useFBO } from "@react-three/drei";
import { ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────
// 2D 비압축 유체 솔버를 '구의 UV 공간'에서 돌리고,
// 결과 dye 텍스처를 3D 구 표면에 입힌다.
// 시뮬 = 평면(텍스처),  표시 = 곡면(구). 둘을 UV가 잇는다.
// ─────────────────────────────────────────────────────────

const SIM_RES = 256;
const PRESSURE_ITER = 30;

const baseVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const advectFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uVelocity, uSource;
  uniform vec2 uTexel; uniform float uDt, uDissipation;
  varying vec2 vUv;
  void main() {
    vec2 vel = texture2D(uVelocity, vUv).xy;
    vec2 coord = vUv - uDt * vel * uTexel;
    gl_FragColor = uDissipation * texture2D(uSource, coord);
  }
`;

const splatFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uTarget; uniform vec3 uColor; uniform vec2 uPoint; uniform float uRadius;
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - uPoint;
    float blob = exp(-dot(d, d) / uRadius);
    gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + blob * uColor, 1.0);
  }
`;

const divergenceFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uVelocity; uniform vec2 uTexel; varying vec2 vUv;
  void main() {
    float L = texture2D(uVelocity, vUv - vec2(uTexel.x,0.0)).x;
    float R = texture2D(uVelocity, vUv + vec2(uTexel.x,0.0)).x;
    float B = texture2D(uVelocity, vUv - vec2(0.0,uTexel.y)).y;
    float T = texture2D(uVelocity, vUv + vec2(0.0,uTexel.y)).y;
    gl_FragColor = vec4(0.5*(R-L+T-B), 0.0, 0.0, 1.0);
  }
`;

const jacobiFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uPressure, uDivergence; uniform vec2 uTexel; varying vec2 vUv;
  void main() {
    float L = texture2D(uPressure, vUv - vec2(uTexel.x,0.0)).x;
    float R = texture2D(uPressure, vUv + vec2(uTexel.x,0.0)).x;
    float B = texture2D(uPressure, vUv - vec2(0.0,uTexel.y)).x;
    float T = texture2D(uPressure, vUv + vec2(0.0,uTexel.y)).x;
    float div = texture2D(uDivergence, vUv).x;
    gl_FragColor = vec4((L+R+B+T-div)*0.25, 0.0, 0.0, 1.0);
  }
`;

const gradientFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uPressure, uVelocity; uniform vec2 uTexel; varying vec2 vUv;
  void main() {
    float L = texture2D(uPressure, vUv - vec2(uTexel.x,0.0)).x;
    float R = texture2D(uPressure, vUv + vec2(uTexel.x,0.0)).x;
    float B = texture2D(uPressure, vUv - vec2(0.0,uTexel.y)).x;
    float T = texture2D(uPressure, vUv + vec2(0.0,uTexel.y)).x;
    vec2 vel = texture2D(uVelocity, vUv).xy - 0.5*vec2(R-L, T-B);
    gl_FragColor = vec4(vel, 0.0, 1.0);
  }
`;

// 구 표면 표시: 물 두께(dye 밝기)로 정점을 밀어올려 형태를 변형
const meshVert = /* glsl */ `
  uniform sampler2D uDye;
  uniform float uDisplace;
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);

    // 물 두께 = dye 밝기. 그만큼 법선 방향으로 정점을 밀어냄.
    float h = clamp(length(texture2D(uDye, uv).rgb) * 0.577, 0.0, 1.0);
    vec3 displaced = position + normal * h * uDisplace;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;
const meshFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uDye;
  uniform vec2 uTexel;
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vec3 dye = texture2D(uDye, vUv).rgb;

    // 두께 경사로 가짜 노멀 틸트 → 볼록함이 빛을 받게 (간단한 relief)
    float hL = length(texture2D(uDye, vUv - vec2(uTexel.x, 0.0)).rgb);
    float hR = length(texture2D(uDye, vUv + vec2(uTexel.x, 0.0)).rgb);
    float hB = length(texture2D(uDye, vUv - vec2(0.0, uTexel.y)).rgb);
    float hT = length(texture2D(uDye, vUv + vec2(0.0, uTexel.y)).rgb);
    vec3 n = normalize(vNormal + vec3(hL - hR, hB - hT, 0.0) * 1.0);

    float light = 0.4 + 0.6 * max(dot(n, normalize(vec3(0.5, 0.8, 0.6))), 0.0);
    vec3 base = vec3(0.05);                 // 어두운 구 바탕
    vec3 color = (base + dye) * light;      // 잉크가 칠해진 곳만 빛남
    gl_FragColor = vec4(color, 1.0);
  }
`;

function useDoubleFBO(opts: THREE.RenderTargetOptions) {
  const a = useFBO(SIM_RES, SIM_RES, opts);
  const b = useFBO(SIM_RES, SIM_RES, opts);
  return useRef({ read: a, write: b });
}

export default function FluidMesh() {
  const { gl } = useThree();

  const opts = useMemo<THREE.RenderTargetOptions>(
    () => ({
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,      // U(경도)는 한 바퀴 → 이어붙임
      wrapT: THREE.ClampToEdgeWrapping, // V(위도)는 극점에서 끝
      depthBuffer: false,
    }),
    []
  );

  const velocity = useDoubleFBO(opts);
  const pressure = useDoubleFBO(opts);
  const dye = useDoubleFBO(opts);
  const divergence = useFBO(SIM_RES, SIM_RES, opts);

  const scene = useMemo(() => new THREE.Scene(), []);
  const camera = useMemo(() => new THREE.Camera(), []);
  const quad = useMemo(() => new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), []);
  useMemo(() => scene.add(quad), [scene, quad]);

  const mats = useMemo(() => {
    const make = (frag: string, u: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: baseVert, fragmentShader: frag, uniforms: u });
    const texel = new THREE.Vector2(1 / SIM_RES, 1 / SIM_RES);
    return {
      advect: make(advectFrag, { uVelocity: { value: null }, uSource: { value: null }, uTexel: { value: texel }, uDt: { value: 0 }, uDissipation: { value: 1 } }),
      splat: make(splatFrag, { uTarget: { value: null }, uColor: { value: new THREE.Vector3() }, uPoint: { value: new THREE.Vector2() }, uRadius: { value: 0.0008 } }),
      divergence: make(divergenceFrag, { uVelocity: { value: null }, uTexel: { value: texel } }),
      jacobi: make(jacobiFrag, { uPressure: { value: null }, uDivergence: { value: null }, uTexel: { value: texel } }),
      gradient: make(gradientFrag, { uPressure: { value: null }, uVelocity: { value: null }, uTexel: { value: texel } }),
    };
  }, []);

  const displayRef = useRef<THREE.ShaderMaterial>(null);

  const blit = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
  };

  // 포인터가 구 표면에서 가리키는 UV (raycast가 교차점 uv를 줌)
  const pointer = useRef({ uv: new THREE.Vector2(), prev: new THREE.Vector2(), active: false, has: false });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (!e.uv) return;
    pointer.current.uv.copy(e.uv);
    pointer.current.active = true;
  };

  const initialized = useRef(false);

  useFrame(({ clock }) => {
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

    // ① 속도 이류
    m.advect.uniforms.uVelocity.value = velocity.current.read.texture;
    m.advect.uniforms.uSource.value = velocity.current.read.texture;
    m.advect.uniforms.uDt.value = dt;
    m.advect.uniforms.uDissipation.value = 0.999;
    blit(m.advect, velocity.current.write);
    [velocity.current.read, velocity.current.write] = [velocity.current.write, velocity.current.read];

    // ② 포인터로 표면에 잉크 + 힘 주입 (UV 공간에서)
    const p = pointer.current;
    if (p.active) {
      const du = p.has ? p.uv.x - p.prev.x : 0;
      const dv = p.has ? p.uv.y - p.prev.y : 0;
      p.prev.copy(p.uv);
      p.has = true;

      // 속도 splat (표면에서 끌고 간 방향)
      m.splat.uniforms.uTarget.value = velocity.current.read.texture;
      m.splat.uniforms.uPoint.value.copy(p.uv);
      m.splat.uniforms.uColor.value.set(du * 8000, dv * 8000, 0);
      blit(m.splat, velocity.current.write);
      [velocity.current.read, velocity.current.write] = [velocity.current.write, velocity.current.read];

      // 색 splat
      const t = clock.elapsedTime;
      m.splat.uniforms.uTarget.value = dye.current.read.texture;
      m.splat.uniforms.uColor.value.set(
        Math.sin(t * 0.7) * 0.5 + 0.5,
        Math.sin(t * 0.9 + 2.0) * 0.5 + 0.5,
        Math.sin(t * 1.1 + 4.0) * 0.5 + 0.5
      );
      blit(m.splat, dye.current.write);
      [dye.current.read, dye.current.write] = [dye.current.write, dye.current.read];

      p.active = false;
    } else {
      p.has = false;
    }

    // ③ 발산
    m.divergence.uniforms.uVelocity.value = velocity.current.read.texture;
    blit(m.divergence, divergence);

    // ④ 압력 Jacobi
    for (let i = 0; i < PRESSURE_ITER; i++) {
      m.jacobi.uniforms.uPressure.value = pressure.current.read.texture;
      m.jacobi.uniforms.uDivergence.value = divergence.texture;
      blit(m.jacobi, pressure.current.write);
      [pressure.current.read, pressure.current.write] = [pressure.current.write, pressure.current.read];
    }

    // ⑤ 기울기 빼기
    m.gradient.uniforms.uPressure.value = pressure.current.read.texture;
    m.gradient.uniforms.uVelocity.value = velocity.current.read.texture;
    blit(m.gradient, velocity.current.write);
    [velocity.current.read, velocity.current.write] = [velocity.current.write, velocity.current.read];

    // ⑥ 색 이류
    m.advect.uniforms.uVelocity.value = velocity.current.read.texture;
    m.advect.uniforms.uSource.value = dye.current.read.texture;
    m.advect.uniforms.uDissipation.value = 0.995;
    blit(m.advect, dye.current.write);
    [dye.current.read, dye.current.write] = [dye.current.write, dye.current.read];

    if (displayRef.current) {
      displayRef.current.uniforms.uDye.value = dye.current.read.texture;
    }
  });

  return (
    <>
      <OrbitControls enablePan={false} />
      <mesh onPointerMove={onMove}>
        <sphereGeometry args={[1, 256, 256]} />
        <shaderMaterial
          ref={displayRef}
          vertexShader={meshVert}
          fragmentShader={meshFrag}
          uniforms={{
            uDye: { value: null },
            uTexel: { value: new THREE.Vector2(1 / SIM_RES, 1 / SIM_RES) },
            uDisplace: { value: 0.1 },
          }}
        />
      </mesh>
    </>
  );
}
