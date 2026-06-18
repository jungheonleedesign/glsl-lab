"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;

  // ── 1단계: 해시 (가짜 난수) ─────────────────────────────
  // 같은 좌표를 넣으면 항상 같은 0~1 값이 나온다 (결정적).
  float random(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  // ── 2단계: 격자점의 무작위 "방향벡터" ───────────────────
  // value noise는 격자점에 '값'을 두지만, perlin은 '기울기 방향'을 둔다.
  vec2 randomGradient(vec2 p) {
    float a = random(p) * 6.2831853;  // 0 ~ 2π 각도
    return vec2(cos(a), sin(a));      // 단위 방향벡터
  }

  // ── 3단계: perlin (gradient) noise ─────────────────────
  float perlin(vec2 p) {
    vec2 i = floor(p);   // 어느 격자 칸인가 (정수 좌표)
    vec2 f = fract(p);   // 칸 안에서의 위치 0~1

    // 네 모서리: (격자점의 기울기) · (격자점→P 방향벡터)
    float a = dot(randomGradient(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
    float b = dot(randomGradient(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float c = dot(randomGradient(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float d = dot(randomGradient(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

    // smoothstep 곡선으로 이음매 없이 보간
    vec2 u = f * f * (3.0 - 2.0 * f);

    // 가로로 두 번(u.x), 세로로 한 번(u.y) 섞기 = 쌍선형 보간
    return mix(mix(a, b, u.x),
               mix(c, d, u.x),
               u.y);
  }

  // ── 4단계: fbm (옥타브를 겹쳐 디테일 만들기) ────────────
  float fbm(vec2 p) {
    float value = 0.0;       // 누적 합
    float amplitude = 0.5;   // 현재 옥타브의 영향력

    // 옥타브 5장: 주파수 2배씩 ↑, 진폭 절반씩 ↓
    for (int i = 0; i < 5; i++) {
      value += amplitude * perlin(p);
      p *= 2.0;             // lacunarity: 다음 옥타브는 더 잘게
      amplitude *= 0.5;     // gain: 다음 옥타브는 더 약하게
    }
    return value;
  }

  // 가벼운 포텐셜 (curl 전용, 3옥타브). 흐름장 계산은 픽셀당 수십 번
  // 불리므로 옥타브를 줄여 성능을 아낀다.
  float potential(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
      value += amplitude * perlin(p);
      p *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  // ── 5단계: curl noise (소용돌이 속도장) ─────────────────
  // 포텐셜 ψ의 기울기를 90도 돌려 속도로 쓴다.
  // 기울기는 등고선과 수직 → 90도 돌리면 등고선을 따라 도는 흐름 = 소용돌이.
  // 이 속도장은 비압축(divergence-free)이라 진짜 유체처럼 보인다.
  // p의 셋째 성분처럼 uTime을 섞어 '흐름장 자체가 살아 움직이게' 한다.
  vec2 curl(vec2 p) {
    float e = 0.01;  // 유한차분 간격 (미분을 두 점의 차이로 근사)
    vec2 t = vec2(0.0, uTime * 0.15);  // 흐름장을 시간에 따라 진화시키는 오프셋

    float dpsi_dx = (potential(p + vec2(e, 0.0) + t) - potential(p - vec2(e, 0.0) + t)) / (2.0 * e);
    float dpsi_dy = (potential(p + vec2(0.0, e) + t) - potential(p - vec2(0.0, e) + t)) / (2.0 * e);

    // 기울기 (dpsi_dx, dpsi_dy) 를 90도 회전 → (dpsi_dy, -dpsi_dx)
    return vec2(dpsi_dy, -dpsi_dx);
  }

  void main() {
    vec2 p = vUv * 3.0;   // 격자 밀도

    // ── streamline 적분 (라그랑주 역추적) ──────────────────
    // "이 점에 흘러온 입자는 어디서 출발했나?"를 물길 따라 거슬러 올라간다.
    // 한 번에 직선으로 밀지 않고, 매 스텝 흐름을 다시 계산해 곡선으로 따라간다.
    vec2 pos = p;
    vec2 wind = vec2(0.15, 0.0);   // 약한 옆바람 (소용돌이를 덮지 않을 정도)
    for (int i = 0; i < 14; i++) {
      vec2 v = curl(pos) + wind;   // 그 위치의 흐름(소용돌이 + 바람)
      pos -= v * 0.04;             // 흐름 반대로 한 스텝 거슬러 올라감
    }

    // 거슬러 올라간 출발점에서 밀도를 읽는다 → 흐름 따라 늘어난 연기 줄기
    float n = fbm(pos);
    n = n * 0.5 + 0.5;
    n = pow(n, 1.8);               // 대비를 키워 줄기를 또렷하게

    // ── 색 ───────────────────────────────────────────────
    vec3 color = mix(vec3(0.02, 0.03, 0.08),       // 어두운 배경
                     vec3(0.95, 0.55, 0.2),        // 연기 색
                     n);
    color += vec3(0.1, 0.25, 0.5) * pow(n, 3.0);   // 짙은 곳에 푸른 광택

    gl_FragColor = vec4(color, 1.0);
  }
`;

export default function ShaderPlane() {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  useFrame(({ clock }) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = clock.getElapsedTime();
    }
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={{
          uTime: { value: 0 },
        }}
      />
    </mesh>
  );
}
