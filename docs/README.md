# GLSL 스터디 — 작동 원리 노트

노이즈부터 3D 입자 물까지, 한 단계씩 쌓아 올린 GLSL/유체 학습 기록.
각 문서는 **외울 원리(개념·왜)** 중심이고, 공식·매직넘버 같은 레시피는 가볍게 다룬다.

## 단계

| # | 문서 | 컴포넌트 | 핵심 |
|---|------|----------|------|
| 1 | [노이즈](01-noise.md) | `ShaderPlane.tsx` | random → perlin → fbm → domain warping → curl |
| 2 | [피드백 연기](02-smoke-feedback.md) | `FluidSim.tsx` | ping-pong 버퍼, advection, curl 속도장 |
| 3 | [볼류메트릭](03-volumetric.md) | `VolumeSmoke.tsx` | 레이마칭, Beer-Lambert, HG 위상, 다중산란, 역투영 |
| 4 | [유체 솔버](04-fluid-solver.md) | `FluidSolver2D.tsx` | 비압축, 압력 투영, Jacobi |
| 5 | [표면 위 유체](05-fluid-on-mesh.md) | `FluidMesh.tsx` | 시뮬↔표시 분리, UV 매핑, vertex 변위 |
| 6 | [입자 물](06-water-particles.md) | `WaterParticles.tsx` | GPGPU 입자, 충돌, 스크린스페이스 유체 렌더 |

화면에 띄울 데모는 `src/components/ShaderCanvas.tsx`의 import 한 줄로 바꾼다.

## 개념 노트 (단계 횡단)

| 문서 | 내용 |
|------|------|
| [GPGPU · 핑퐁 · semi-Lagrangian](concepts-gpgpu.md) | 세 층의 구분 (패러다임 / 배관 / 알고리즘) |

## 계속 재등장하는 원리 (이게 진짜 자산)

```
셰이더 = 픽셀당 함수      GPU가 수백만 픽셀에 같은 함수를 병렬 실행
uniform/varying/attribute 전역값 / 보간값 / 꼭짓점값 — 데이터 3종
mix(a,b,t)               선형 보간(lerp). 모든 섞기의 기본
보간                     쌍선형(2D 4점) → 삼선형(3D 8점)
마스킹 = 곱하기           0~1 마스크를 곱해 영역을 자름 (게이트)
90도 회전 (-y, x)        기울기를 돌려 소용돌이 만들기 (curl)
내적 dot                 벡터를 방향 성분으로 분해 (각도·정렬도)
ping-pong 버퍼           이전 프레임을 읽어 갱신 → '기억' (시뮬의 토대)
레이마칭 p(t)=ro+rd·t     3D를 1D(t)로 환원해 공간을 행진
역투영 (P·V)⁻¹           2D 화면 → 3D 광선 (투영의 역)
construct vs project     비압축을 '구성'(curl) vs '투영'(압력 솔버)
```

## 큰 그림 — 무엇이 무엇 위에 쌓였나

```
1 노이즈 ─────────────┐
2 피드백(ping-pong) ──┼─→ 4 유체 솔버 (압력 투영)
   + curl 속도장      │        │
3 레이마칭 ───────────┘        ├─→ 5 표면 위 유체 (UV + vertex 변위)
                               └─→ 6 입자 물 (ping-pong + vertex 텍스처 읽기
                                        + 스크린스페이스 렌더)
```
