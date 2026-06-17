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

  void main() {
    vec2 uv = vUv;

    // uv 좌표를 -1 ~ 1 범위로 변환 (NDC처럼)
    vec2 st = uv * 2.0 - 1.0;

    float r = length(st);           // 원점으로부터의 거리
    float angle = atan(st.y, st.x); // 각도

    float ring = sin(r * 10.0 - uTime * 2.0);

    vec3 color = vec3(ring * 0.5 + 0.5, uv.x, uv.y);

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
