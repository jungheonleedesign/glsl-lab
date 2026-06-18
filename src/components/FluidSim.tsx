"use client";

import { useFBO } from "@react-three/drei";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────
// 공용 GLSL: 노이즈 → curl 속도장 (시뮬 셰이더에서 재사용)
// ShaderPlane.tsx에서 만든 것과 동일한 perlin/fbm/curl.
// ─────────────────────────────────────────────────────────
const noiseChunk = /* glsl */ `
  float random(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  vec2 randomGradient(vec2 p) {
    float a = random(p) * 6.2831853;
    return vec2(cos(a), sin(a));
  }
  float perlin(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = dot(randomGradient(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
    float b = dot(randomGradient(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float c = dot(randomGradient(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float d = dot(randomGradient(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  // curl 전용 가벼운 포텐셜 (3옥타브)
  float potential(vec2 p) {
    float value = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 3; i++) { value += amp * perlin(p); p *= 2.0; amp *= 0.5; }
    return value;
  }
  // 비압축 소용돌이 속도장. uTime을 섞어 흐름장이 살아 움직인다.
  vec2 curl(vec2 p, float t) {
    float e = 0.01;
    vec2 off = vec2(0.0, t * 0.15);
    float dx = (potential(p + vec2(e,0.0) + off) - potential(p - vec2(e,0.0) + off)) / (2.0*e);
    float dy = (potential(p + vec2(0.0,e) + off) - potential(p - vec2(0.0,e) + off)) / (2.0*e);
    return vec2(dy, -dx);
  }
`;

// 화면 밖 풀스크린 쿼드: 카메라 무시하고 클립공간에 바로 그림
const passthroughVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ── 시뮬 셰이더: 이전 밀도를 읽어 흐름 따라 옮기고 소스를 더한다 ──
const simFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uPrev;     // 이전 프레임 밀도
  uniform float uTime;
  uniform float uDt;           // 흐름 스텝 크기
  uniform vec2  uMouse;        // 마우스 위치 (uv 0~1)
  uniform vec2  uMouseVel;     // 마우스 속도 (힘)
  uniform float uAspect;       // 가로/세로 비 (둥근 소스용)
  varying vec2 vUv;

  ${noiseChunk}

  void main() {
    vec2 uv = vUv;

    // 1) 속도장: curl 난류 + 위로 뜨는 부력
    vec2 vel = curl(uv * 3.0, uTime) * 1.0;
    vel.y += 1.2;  // 부력: 연기는 위로 오른다

    // 마우스가 움직이면 그 속도를 주변에 힘으로 더한다 (휘젓기)
    vec2 md = (uv - uMouse) * vec2(uAspect, 1.0);
    float mInfluence = smoothstep(0.15, 0.0, length(md));
    vel += uMouseVel * mInfluence * 20.0;

    // 2) advection: 한 프레임 전 위치의 밀도를 끌어온다 (semi-Lagrangian)
    vec2 src = uv - vel * uDt;
    float density = texture2D(uPrev, src).r;

    // 3) 소산: 조금씩 옅어짐
    density *= 0.97;

    // 4) 소스 주입 ─ 바닥 중앙의 상시 발생원
    vec2 emit = vec2(0.5, 0.06);
    float ed = length((uv - emit) * vec2(uAspect, 1.0));
    density += smoothstep(0.04, 0.0, ed) * 0.45;

    

    density = clamp(density, 0.0, 1.0);
    gl_FragColor = vec4(vec3(density), 1.0);
  }
`;

// ── 디스플레이 셰이더: 밀도 → 색 ──
const displayFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uTexture;
  varying vec2 vUv;

  void main() {
    float d = texture2D(uTexture, vUv).r;

    // 불꽃/연기 그라데이션: 검정 → 자주 → 주황 → 노랑 → 흰
    vec3 col = vec3(0.02, 0.02, 0.05);
    col = mix(col, vec3(0.5, 0.1, 0.3), smoothstep(0.0, 0.3, d));
    col = mix(col, vec3(0.95, 0.5, 0.15), smoothstep(0.25, 0.6, d));
    col = mix(col, vec3(1.0, 0.95, 0.7), smoothstep(0.6, 1.0, d));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export default function FluidSim() {
  const { gl, size } = useThree();

  // 시뮬 해상도 (성능 위해 절반으로). 화면은 linear 보간으로 부드럽게 확대.
  const simW = Math.max(2, Math.floor(size.width / 2));
  const simH = Math.max(2, Math.floor(size.height / 2));

  const fboOpts = {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  };
  const fboA = useFBO(simW, simH, fboOpts);
  const fboB = useFBO(simW, simH, fboOpts);

  // read/write 역할을 ref로 들고 매 프레임 swap
  const targets = useRef({ read: fboA, write: fboB });
  const initialized = useRef(false);

  // 화면 밖 시뮬 장면/카메라/머티리얼
  const simScene = useMemo(() => new THREE.Scene(), []);
  const simCamera = useMemo(() => new THREE.Camera(), []);
  const simMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: passthroughVert,
        fragmentShader: simFrag,
        uniforms: {
          uPrev: { value: null },
          uTime: { value: 0 },
          uDt: { value: 0 },
          uMouse: { value: new THREE.Vector2(-1, -1) },
          uMouseVel: { value: new THREE.Vector2(0, 0) },
          uAspect: { value: 1 },
        },
      }),
    []
  );

  const displayRef = useRef<THREE.ShaderMaterial>(null);

  // 마우스 추적 (이전 위치로 속도 계산)
  const prevMouse = useRef(new THREE.Vector2(-1, -1));

  useFrame((state, delta) => {
    // 최초 1회: 두 버퍼를 검정으로 초기화 (HalfFloat 쓰레기값 방지)
    if (!initialized.current) {
      [fboA, fboB].forEach((f) => {
        gl.setRenderTarget(f);
        gl.clear();
      });
      gl.setRenderTarget(null);
      initialized.current = true;
    }

    const { read, write } = targets.current;

    // 마우스: NDC(-1~1) → uv(0~1), 속도 계산
    const mx = state.pointer.x * 0.5 + 0.5;
    const my = state.pointer.y * 0.5 + 0.5;
    const mvx = mx - prevMouse.current.x;
    const mvy = my - prevMouse.current.y;
    prevMouse.current.set(mx, my);

    // 시뮬 uniform 갱신
    simMat.uniforms.uPrev.value = read.texture;
    simMat.uniforms.uTime.value = state.clock.elapsedTime;
    simMat.uniforms.uDt.value = Math.min(delta, 0.033) * 0.5;
    simMat.uniforms.uMouse.value.set(mx, my);
    simMat.uniforms.uMouseVel.value.set(mvx, mvy);
    simMat.uniforms.uAspect.value = simW / simH;

    // 화면 밖에서 시뮬 실행: read → write
    gl.setRenderTarget(write);
    gl.render(simScene, simCamera);
    gl.setRenderTarget(null);

    // 방금 쓴 결과를 화면에 표시
    if (displayRef.current) {
      displayRef.current.uniforms.uTexture.value = write.texture;
    }

    // 역할 swap
    targets.current.read = write;
    targets.current.write = read;
  });

  return (
    <>
      {/* 화면 밖 시뮬 쿼드 (simScene 안으로 포탈) */}
      {createPortal(
        <mesh material={simMat}>
          <planeGeometry args={[2, 2]} />
        </mesh>,
        simScene
      )}

      {/* 화면용 메시 */}
      <mesh>
        <planeGeometry args={[2, 2]} />
        <shaderMaterial
          ref={displayRef}
          vertexShader={passthroughVert}
          fragmentShader={displayFrag}
          uniforms={{ uTexture: { value: null } }}
        />
      </mesh>
    </>
  );
}
