"use client";

import { OrbitControls, useFBO } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────
// 3D 입자 물 (GPGPU) + 스크린스페이스 유체 렌더링.
//   시뮬: 입자 위치·속도를 텍스처에 저장, ping-pong 갱신 (중력·충돌)
//   렌더: 입자를 부드러운 블롭으로 누적 → '두께' → 매끈한 물 표면 합성
// ─────────────────────────────────────────────────────────

const P = 300;                   // 입자 격자 한 변 (P*P 입자)
const SPHERE_R = 1.0;
const FLOOR_Y = -1.6;
const EMITTER = [0.0, 2.2, 0.0];

const baseVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const hashGlsl = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
`;
const constsGlsl = `
  const float SPHERE_R = ${SPHERE_R.toFixed(3)};
  const float FLOOR_Y = ${FLOOR_Y.toFixed(3)};
`;

// ── 시뮬 셰이더들 (이전과 동일) ───────────────────────────
const seedPosFrag = /* glsl */ `
  precision highp float; ${hashGlsl} ${constsGlsl} varying vec2 vUv;
  void main(){
    float r1=hash(vUv*1.7), r2=hash(vUv*3.1+5.0), r3=hash(vUv*7.3+11.0);
    vec3 p=vec3((r1-0.5)*0.25, mix(FLOOR_Y,2.2,r2), (r3-0.5)*0.25);
    gl_FragColor=vec4(p, hash(vUv*9.1));
  }
`;
const seedVelFrag = /* glsl */ `
  precision highp float; ${hashGlsl} varying vec2 vUv;
  void main(){ gl_FragColor=vec4(0.0, -hash(vUv)*0.5, 0.0, 0.0); }
`;
const velFrag = /* glsl */ `
  precision highp float; ${hashGlsl} ${constsGlsl}
  uniform sampler2D uPos,uVel; uniform float uDt,uTime,uGravity,uRestitution,uFriction;
  varying vec2 vUv;
  void main(){
    vec4 posL=texture2D(uPos,vUv); vec3 pos=posL.xyz; float life=posL.a;
    vec3 vel=texture2D(uVel,vUv).xyz;
    if(life<=0.0){
      float rx=hash(vUv+uTime)-0.5, rz=hash(vUv+uTime+3.7)-0.5;
      vel=vec3(rx*0.6, -0.5-hash(vUv+uTime)*0.5, rz*0.6);
    } else {
      vel.y -= uGravity*uDt;
      vec3 predict=pos+vel*uDt;
      if(length(predict)<SPHERE_R){
        vec3 n=normalize(pos); float vn=dot(vel,n);
        if(vn<0.0) vel-=(1.0+uRestitution)*vn*n;
        vel*=uFriction;
      }
      if(predict.y<FLOOR_Y && vel.y<0.0){ vel.y=-vel.y*uRestitution; vel.xz*=uFriction; }
    }
    gl_FragColor=vec4(vel,0.0);
  }
`;
const posFrag = /* glsl */ `
  precision highp float; ${hashGlsl} ${constsGlsl}
  uniform sampler2D uPos,uVel; uniform float uDt,uDecay; varying vec2 vUv;
  void main(){
    vec4 posL=texture2D(uPos,vUv); vec3 pos=posL.xyz; float life=posL.a;
    vec3 vel=texture2D(uVel,vUv).xyz;
    if(life<=0.0){
      pos=vec3(${EMITTER[0].toFixed(1)},${EMITTER[1].toFixed(1)},${EMITTER[2].toFixed(1)})
          +vec3((hash(vUv)-0.5)*0.2,0.0,(hash(vUv+2.3)-0.5)*0.2);
      life=1.0;
    } else {
      pos+=vel*uDt;
      if(length(pos)<SPHERE_R) pos=normalize(pos)*SPHERE_R;
      if(pos.y<FLOOR_Y) pos.y=FLOOR_Y;
      life-=uDt*uDecay;
    }
    gl_FragColor=vec4(pos,life);
  }
`;

// ── 입자를 '두께'로 누적 (가산 블렌딩) ────────────────────
const accumVert = /* glsl */ `
  uniform sampler2D uPos; uniform float uPointSize;
  attribute vec2 ref; varying float vLife;
  void main(){
    vec4 p=texture2D(uPos,ref); vLife=p.a;
    vec4 mv=modelViewMatrix*vec4(p.xyz,1.0);
    gl_Position=projectionMatrix*mv;
    gl_PointSize=uPointSize/(-mv.z);
  }
`;
const accumFrag = /* glsl */ `
  precision highp float; varying float vLife;
  void main(){
    if(vLife<=0.0) discard;
    vec2 c=gl_PointCoord-0.5; float d2=dot(c,c);
    if(d2>0.25) discard;
    float w=exp(-d2*8.0);           // 부드러운 블롭
    gl_FragColor=vec4(w,0.0,0.0,1.0);
  }
`;

// ── 두께 블러 (분리형 가우시안): 입자 봉우리를 뭉개 매끈하게 ──
const blurFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2 uDir;          // 한 방향 오프셋 (가로 또는 세로) × 반경
  varying vec2 vUv;
  void main(){
    float s = texture2D(uTex, vUv).r * 0.227;
    s += (texture2D(uTex, vUv + uDir*1.0).r + texture2D(uTex, vUv - uDir*1.0).r) * 0.194;
    s += (texture2D(uTex, vUv + uDir*2.0).r + texture2D(uTex, vUv - uDir*2.0).r) * 0.121;
    s += (texture2D(uTex, vUv + uDir*3.0).r + texture2D(uTex, vUv - uDir*3.0).r) * 0.054;
    s += (texture2D(uTex, vUv + uDir*4.0).r + texture2D(uTex, vUv - uDir*4.0).r) * 0.016;
    gl_FragColor = vec4(s, 0.0, 0.0, 1.0);
  }
`;

// ── 합성: 두께 → 매끈한 물 표면 ───────────────────────────
const compFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene, uFluid;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main(){
    float t = texture2D(uFluid, vUv).r;            // 물 두께
    vec3 bg = texture2D(uScene, vUv).rgb;          // 뒤 배경(구·바닥)
    float mask = smoothstep(0.12, 0.4, t);
    if(mask < 0.001){ gl_FragColor=vec4(bg,1.0); return; }

    // 두께를 높이로 보고 기울기 → 표면 법선
    float tL=texture2D(uFluid, vUv-vec2(uTexel.x,0.0)).r;
    float tR=texture2D(uFluid, vUv+vec2(uTexel.x,0.0)).r;
    float tB=texture2D(uFluid, vUv-vec2(0.0,uTexel.y)).r;
    float tT=texture2D(uFluid, vUv+vec2(0.0,uTexel.y)).r;
    vec3 n = normalize(vec3(tL-tR, tB-tT, 0.08));

    // 굴절: 배경을 법선만큼 휘어 비춤
    vec3 refr = texture2D(uScene, vUv + n.xy*0.06).rgb;

    // Beer-Lambert: 두꺼울수록 짙은 파랑 (얇으면 투명)
    vec3 absorb = exp(-t * vec3(2.2, 1.0, 0.5));   // 빨강을 더 흡수 → 파랑
    vec3 deep = vec3(0.05, 0.2, 0.4);
    vec3 water = mix(deep, refr, absorb);

    // 프레넬(비스듬히 보면 반사) + 스페큘러
    float fres = pow(1.0 - max(n.z, 0.0), 3.0);
    vec3 sky = vec3(0.7, 0.85, 1.0);
    vec3 col = mix(water, sky, fres * 0.6);
    float spec = pow(max(dot(n, normalize(vec3(0.4,0.7,0.6))), 0.0), 60.0);
    col += spec * 1.5;

    gl_FragColor = vec4(mix(bg, col, mask), 1.0);
  }
`;

function useDoubleFBO(opts: THREE.RenderTargetOptions) {
  const a = useFBO(P, P, opts);
  const b = useFBO(P, P, opts);
  return useRef({ read: a, write: b });
}

export default function WaterParticles() {
  const { gl, size, camera } = useThree();

  // 입자 데이터 버퍼 (보간 금지 → Nearest)
  const dataOpts = useMemo<THREE.RenderTargetOptions>(
    () => ({ type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false }),
    []
  );
  const posFBO = useDoubleFBO(dataOpts);
  const velFBO = useDoubleFBO(dataOpts);

  // 화면 크기 타깃: 배경(구·바닥) + 물 두께
  const sceneTarget = useFBO(size.width, size.height, { depthBuffer: true });
  const fluidTarget = useFBO(size.width, size.height, { type: THREE.HalfFloatType, depthBuffer: false });
  const fluidTargetB = useFBO(size.width, size.height, { type: THREE.HalfFloatType, depthBuffer: false });

  // 시뮬용 오프스크린 쿼드
  const simScene = useMemo(() => new THREE.Scene(), []);
  const simCam = useMemo(() => new THREE.Camera(), []);
  const quad = useMemo(() => new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), []);
  useMemo(() => simScene.add(quad), [simScene, quad]);

  const simMats = useMemo(() => {
    const make = (frag: string, u: Record<string, THREE.IUniform> = {}) =>
      new THREE.ShaderMaterial({ vertexShader: baseVert, fragmentShader: frag, uniforms: u });
    return {
      seedPos: make(seedPosFrag),
      seedVel: make(seedVelFrag),
      vel: make(velFrag, { uPos: { value: null }, uVel: { value: null }, uDt: { value: 0 }, uTime: { value: 0 }, uGravity: { value: 5.0 }, uRestitution: { value: 0.3 }, uFriction: { value: 0.94 } }),
      pos: make(posFrag, { uPos: { value: null }, uVel: { value: null }, uDt: { value: 0 }, uDecay: { value: 0.35 } }),
      blur: make(blurFrag, { uTex: { value: null }, uDir: { value: new THREE.Vector2() } }),
      comp: make(compFrag, { uScene: { value: null }, uFluid: { value: null }, uTexel: { value: new THREE.Vector2() } }),
    };
  }, []);

  // 입자 점 지오메트리 (각 점이 데이터 텍스처의 어느 텍셀인지)
  const pointsGeo = useMemo(() => {
    const count = P * P;
    const refs = new Float32Array(count * 2);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      refs[i * 2] = ((i % P) + 0.5) / P;
      refs[i * 2 + 1] = (Math.floor(i / P) + 0.5) / P;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("ref", new THREE.BufferAttribute(refs, 2));
    return g;
  }, []);

  // 입자 누적용 머티리얼 + 장면
  const accumMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: accumVert,
        fragmentShader: accumFrag,
        uniforms: { uPos: { value: null }, uPointSize: { value: 22 } },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    []
  );
  const particleScene = useMemo(() => {
    const s = new THREE.Scene();
    s.add(new THREE.Points(pointsGeo, accumMat));
    return s;
  }, [pointsGeo, accumMat]);

  // 배경 솔리드 장면 (구 걸림돌 + 바닥 + 조명)
  const solids = useMemo(() => {
    const s = new THREE.Scene();
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_R, 48, 48), new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.6 }));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    const dl = new THREE.DirectionalLight(0xffffff, 1.2);
    dl.position.set(3, 5, 2);
    s.add(sphere, floor, new THREE.AmbientLight(0xffffff, 0.4), dl);
    return s;
  }, []);

  const blit = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => {
    quad.material = mat;
    gl.setRenderTarget(target);
    gl.render(simScene, simCam);
  };

  const initialized = useRef(false);

  // priority 1 → R3F 자동 렌더 끄고 직접 멀티패스 렌더
  useFrame(({ clock }, delta) => {
    if (!initialized.current) {
      blit(simMats.seedPos, posFBO.current.read);
      blit(simMats.seedPos, posFBO.current.write);
      blit(simMats.seedVel, velFBO.current.read);
      blit(simMats.seedVel, velFBO.current.write);
      initialized.current = true;
    }

    const dt = Math.min(delta, 0.033);

    // ① 속도 갱신
    simMats.vel.uniforms.uPos.value = posFBO.current.read.texture;
    simMats.vel.uniforms.uVel.value = velFBO.current.read.texture;
    simMats.vel.uniforms.uDt.value = dt;
    simMats.vel.uniforms.uTime.value = clock.elapsedTime;
    blit(simMats.vel, velFBO.current.write);
    [velFBO.current.read, velFBO.current.write] = [velFBO.current.write, velFBO.current.read];

    // ② 위치 갱신
    simMats.pos.uniforms.uPos.value = posFBO.current.read.texture;
    simMats.pos.uniforms.uVel.value = velFBO.current.read.texture;
    simMats.pos.uniforms.uDt.value = dt;
    blit(simMats.pos, posFBO.current.write);
    [posFBO.current.read, posFBO.current.write] = [posFBO.current.write, posFBO.current.read];

    // ③ 배경 솔리드 → sceneTarget
    gl.setRenderTarget(sceneTarget);
    gl.setClearColor(0x05070d, 1);
    gl.clear();
    gl.render(solids, camera);

    // ④ 입자 두께 누적 → fluidTarget
    accumMat.uniforms.uPos.value = posFBO.current.read.texture;
    gl.setRenderTarget(fluidTarget);
    gl.setClearColor(0x000000, 1);
    gl.clear();
    gl.render(particleScene, camera);

    // ④-b 두께 블러 (입자 봉우리를 뭉개 매끈한 표면으로)
    const tx = 1 / size.width, ty = 1 / size.height;
    const radius = 2.5;        // 블러 반경 (키우면 더 매끈/뭉침)
    const iterations = 3;
    for (let i = 0; i < iterations; i++) {
      simMats.blur.uniforms.uTex.value = fluidTarget.texture;
      simMats.blur.uniforms.uDir.value.set(tx * radius, 0);
      blit(simMats.blur, fluidTargetB);
      simMats.blur.uniforms.uTex.value = fluidTargetB.texture;
      simMats.blur.uniforms.uDir.value.set(0, ty * radius);
      blit(simMats.blur, fluidTarget);
    }

    // ⑤ 합성 → 화면
    simMats.comp.uniforms.uScene.value = sceneTarget.texture;
    simMats.comp.uniforms.uFluid.value = fluidTarget.texture;
    simMats.comp.uniforms.uTexel.value.set(1 / size.width, 1 / size.height);
    quad.material = simMats.comp;
    gl.setRenderTarget(null);
    gl.render(simScene, simCam);
  }, 1);

  return <OrbitControls enablePan={false} />;
}
