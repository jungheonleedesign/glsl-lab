"use client";

import { Canvas } from "@react-three/fiber";
import WaterParticles from "./WaterParticles";

export default function ShaderCanvas() {
  return (
    <Canvas
      style={{ width: "100%", height: "100%" }}
      gl={{ antialias: false }}
      camera={{ position: [3, 1.5, 3], fov: 50, near: 0.1, far: 100 }}
    >
      <WaterParticles />
    </Canvas>
  );
}
