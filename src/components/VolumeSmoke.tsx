"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// 상자 표면의 월드 좌표를 프래그먼트로 넘긴다 (광선 방향 계산용).
const vert = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const frag = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uLightPos;
  uniform vec3 uMousePos;      // 마우스의 3D 위치 (역투영 결과)
  uniform float uMouseActive;  // 마우스 영향 on/off (0~1)
  uniform float uMouseSpeed;   // 마우스 이동 속도 (커질수록 curl ↑)
  varying vec3 vWorldPos;
  // cameraMatrix 등은 three가 자동 주입: cameraPosition

  // ── 3D 해시 + 값 노이즈 (2D를 3D로 확장) ────────────────
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  // 3D 값 노이즈: 8개 꼭짓점을 삼선형(trilinear) 보간
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);  // smoothstep
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
  // 3D fbm
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  // ── 공간 한 점의 연기 밀도 ──────────────────────────────
  float sampleDensity(vec3 p) {
    vec3 q = p;
    q.y -= uTime * 0.15;            // 연기가 위로 오르는 효과 (샘플을 아래로 흘림)

    // ── 마우스 교란: 커서 근처 좌표를 회전 변위로 비틀어 휘젓는다 ──
    vec3 toM = p - uMousePos;
    float infl = smoothstep(0.32, 0.0, length(toM)) * uMouseActive;
    // (-y, x) = xy평면 90도 회전 → 커서 둘레를 도는 소용돌이 변위.
    // uMouseSpeed를 곱해 '커서가 빠를수록 더 세게' 휘젓는다.
    vec3 swirl = vec3(-toM.y, toM.x, 0.0) * infl * uMouseSpeed * 25.0;
    q += swirl;

    float d = fbm(q * 2.5 + 1.3);

    // 구 모양으로 가둠 (상자 모서리에서 딱 잘리지 않게)
    float shape = smoothstep(0.55, 0.2, length(p));
    d *= shape;

    // 임계값 빼서 빈 공간은 0, 짙은 곳만 남김 (연기 결)
    return max(d - 0.25, 0.0) * 4.0;
  }

  // ── 광선-상자 교차 (슬랩 방식): 들어오고 나가는 t ────────
  vec2 intersectBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
    vec3 t0 = (bmin - ro) / rd;
    vec3 t1 = (bmax - ro) / rd;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float tN = max(max(tmin.x, tmin.y), tmin.z);
    float tF = min(min(tmax.x, tmax.y), tmax.z);
    return vec2(tN, tF);
  }

  // ── 광원 쪽으로 짧게 행진해 누적 밀도(광학두께)를 잰다 ────
  // 투과율(exp)을 바로 돌려주지 않고 '밀도 합'을 돌려준다.
  // 다중 산란 겹마다 흡수계수를 다르게 적용하기 위함.
  float lightDepth(vec3 p) {
    vec3 ld = normalize(uLightPos - p);
    float density = 0.0;
    float stepSize = 0.06;
    for (int i = 0; i < 6; i++) {
      p += ld * stepSize;
      density += sampleDensity(p) * stepSize;
    }
    return density;
  }

  // ── Henyey-Greenstein 위상함수 ──────────────────────────
  // cosTheta = dot(보는방향, 빛방향). g로 앞/뒤 산란 쏠림 조절.
  // 앞 산란(g>0)이면 빛 쪽을 볼 때 값이 커져서 광륜(glow)이 생긴다.
  float henyeyGreenstein(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
  }

  void main() {
    vec3 ro = cameraPosition;                    // 광선 시작 = 카메라
    vec3 rd = normalize(vWorldPos - ro);         // 광선 방향 = 이 픽셀 방향

    vec2 hit = intersectBox(ro, rd, vec3(-0.5), vec3(0.5));
    float tN = max(hit.x, 0.0);
    float tF = hit.y;

    // 밴딩 줄이는 미세 지터 (시작점을 픽셀마다 살짝 흔듦)
    float jitter = hash(vec3(gl_FragCoord.xy, uTime)) * 0.02;
    float t = tN + jitter;

    float stepSize = 0.02;
    float transmittance = 1.0;   // 남은 투과율 (1=훤히 보임)
    vec3 color = vec3(0.0);      // 누적 색

    vec3 smokeColor = vec3(0.9, 0.92, 1.0);   // 연기 알베도
    vec3 lightColor = vec3(1.0, 0.85, 0.6);   // 따뜻한 광원 색
    vec3 ambient    = vec3(0.12, 0.14, 0.2);  // 그늘에도 깔리는 환경광

    // ── 광선 따라 행진 ─────────────────────────────────
    for (int i = 0; i < 80; i++) {
      if (t > tF || transmittance < 0.01) break;

      vec3 pos = ro + rd * t;
      float dens = sampleDensity(pos);

      if (dens > 0.001) {
        // 이 점 기준 빛 방향, 그리고 보는 방향과의 각도
        vec3 ld = normalize(uLightPos - pos);
        float cosTheta = dot(rd, ld);
        float depthToLight = lightDepth(pos);                 // 빛까지 누적 밀도

        // ── 다중 산란 근사: 점점 약·깊·흐린 산란을 합산 ──
        vec3 scattered = smokeColor * ambient;
        float att = 1.0;      // 흡수 스케일 (겹마다 ↓ → 빛이 더 깊이 침투)
        float contrib = 1.0;  // 기여도   (겹마다 ↓ → 에너지 약화)
        float ecc = 1.0;      // 위상 g 스케일 (겹마다 ↓ → 더 등방)
        for (int o = 0; o < 3; o++) {
          float Tl    = exp(-depthToLight * 4.0 * att);       // 이 겹의 빛 투과율
          float phase = henyeyGreenstein(cosTheta, 0.6 * ecc);
          scattered += smokeColor * contrib * Tl * phase * lightColor * 6.0;
          att *= 0.4; contrib *= 0.5; ecc *= 0.5;             // 다음 겹: 약·깊·흐리게
        }

        float a = dens * stepSize * 6.0;                       // 이 스텝의 불투명도
        color += transmittance * a * scattered;               // front-to-back 합성
        transmittance *= 1.0 - a;
      }
      t += stepSize;
    }

    // 검은 배경 위에 합성된 결과 (투과율만큼 배경=검정이 비침)
    gl_FragColor = vec4(color, 1.0);
  }
`;

export default function VolumeSmoke() {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLightPos: { value: new THREE.Vector3(1.5, 2.0, 1.0) },
      uMousePos: { value: new THREE.Vector3(0, 0, 0) },
      uMouseActive: { value: 0 },
      uMouseSpeed: { value: 0 },
    }),
    []
  );

  // 역투영 재사용 객체 (매 프레임 new 방지)
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const plane = useMemo(() => new THREE.Plane(), []);
  const planeNormal = useMemo(() => new THREE.Vector3(), []);
  const hitPoint = useMemo(() => new THREE.Vector3(), []);
  const prevMousePos = useRef(new THREE.Vector3());  // 직전 프레임 커서 3D 위치

  useFrame(({ clock, camera, pointer }) => {
    if (!matRef.current) return;
    const mat = matRef.current;
    mat.uniforms.uTime.value = clock.getElapsedTime();

    // 1) 역투영: 마우스 NDC → 카메라에서 뻗는 3D 광선
    raycaster.setFromCamera(pointer, camera);

    // 2) 광선 ∩ 평면: 원점을 지나고 카메라를 향하는 평면과 교차
    camera.getWorldDirection(planeNormal);            // 카메라가 보는 방향(정규화됨)
    plane.normal.copy(planeNormal);
    plane.constant = 0;                               // 원점 통과
    const hit = raycaster.ray.intersectPlane(plane, hitPoint);

    if (hit) {
      // 3) 속도 = 직전 위치와의 거리 (프레임 간 이동량)
      const speed = hitPoint.distanceTo(prevMousePos.current);
      prevMousePos.current.copy(hitPoint);

      // 멈출 때 뚝 끊기지 않게 감쇠 추적 (값이 부드럽게 따라옴)
      mat.uniforms.uMouseSpeed.value +=
        (speed - mat.uniforms.uMouseSpeed.value) * 0.25;

      mat.uniforms.uMousePos.value.copy(hitPoint);
      mat.uniforms.uMouseActive.value = 1;
    } else {
      mat.uniforms.uMouseSpeed.value = 0;
      mat.uniforms.uMouseActive.value = 0;
    }
  });

  return (
    <>
      <OrbitControls enablePan={false} />
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <shaderMaterial
          ref={matRef}
          vertexShader={vert}
          fragmentShader={frag}
          uniforms={uniforms}
          side={THREE.BackSide}
          transparent
          depthWrite={false}
        />
      </mesh>
    </>
  );
}
