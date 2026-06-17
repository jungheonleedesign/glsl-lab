"use client";

import { Canvas } from "@react-three/fiber";
import ShaderPlane from "./ShaderPlane";

export default function ShaderCanvas() {
  return (
    <Canvas
      style={{ width: "100%", height: "100%" }}
      gl={{ antialias: false }}
      camera={{ position: [0, 0, 1] }}
    >
      <ShaderPlane />
    </Canvas>
  );
}
