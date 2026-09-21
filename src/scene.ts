import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { gstime, jday, sunPos } from 'satellite.js';
import { makeEarthMaterial, phosphorUniform } from './earthShader';
import { EarthTiles } from './earthTiles';

// Scene units: 1 = Earth's equatorial radius. The scene frame is ECI (inertial):
// ECI (x, y, z) maps to three.js (x, z, -y) so that +Y points to the north pole.
// The Earth mesh is rotated by Greenwich sidereal time instead of moving the satellites.
export const EARTH_RADIUS_KM = 6378.137;

export function eciToScene(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(x / EARTH_RADIUS_KM, z / EARTH_RADIUS_KM, -y / EARTH_RADIUS_KM);
}

export type VisualMode = 'phosphor' | 'true';

/** Alpha written by satellite glyphs; the phosphor pass leaves pixels carrying it untouched. */
export const PASSTHROUGH_ALPHA = 0.5;

/**
 * Turns the rendered frame into a single-colour phosphor display: brightness maps onto an
 * amber ramp (hot highlights run toward pale amber). Two things keep their own colour: pixels
 * written with the pass-through alpha marker (the category-coloured satellite glyphs), and
 * near-pure red (the target's orbit and drop line), which stays warning red. Runs in linear space, before the sRGB output pass.
 */
const PhosphorShader = {
  uniforms: {
    tDiffuse: { value: null },
    amber: { value: new THREE.Color('#ffb000') },
    hot: { value: new THREE.Color('#ffe2a0') },
    warn: { value: new THREE.Color('#ff3333') },
    passthroughAlpha: { value: PASSTHROUGH_ALPHA },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 amber;
    uniform vec3 hot;
    uniform vec3 warn;
    uniform float passthroughAlpha;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float lum = clamp(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * 1.7, 0.0, 1.0);
      vec3 phos = amber * pow(lum, 0.8);
      phos = mix(phos, hot, smoothstep(0.75, 1.0, lum) * 0.6);
      if (abs(c.a - passthroughAlpha) < 0.02) {
        gl_FragColor = vec4(c.rgb, 1.0);
        return;
      }
      // Only near-pure red survives; orange city lights must not.
      bool isWarn = c.r > 0.2 && max(c.g, c.b) < 0.12 * c.r;
      gl_FragColor = vec4(isWarn ? warn * (0.35 + 0.65 * c.r) : phos, 1.0);
    }
  `,
};

const TEXTURE_BASE = 'https://cdn.jsdelivr.net/npm/three-globe/example/img/';

const atmosphereFragment = /* glsl */ `
  uniform vec3 sunDir;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    float rim = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), 3.0);
    float lit = 0.35 + 0.65 * smoothstep(-0.3, 0.4, dot(normalize(vNormalW), sunDir));
    gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * rim * lit, rim * lit);
  }
`;

const atmosphereVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export class GlobeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly earth: THREE.Mesh;
  readonly tiles: EarthTiles;
  readonly sunDir = new THREE.Vector3(1, 0, 0);
  private readonly composer: EffectComposer;
  private mode: VisualMode = 'phosphor';
  private readonly sunLight = new THREE.DirectionalLight('#fff6e8', 3);
  private readonly tmp = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
    this.camera.position.set(0, 1.2, 4.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.3;
    this.controls.maxDistance = 40;
    this.controls.rotateSpeed = 0.5;

    const loader = new THREE.TextureLoader();
    const load = (file: string) => {
      const tex = loader.load(TEXTURE_BASE + file);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      return tex;
    };

    // Low-res base globe, sunk 6 km so the high-res NASA tiles always draw on top of it.
    this.earth = new THREE.Mesh(
      new THREE.SphereGeometry(0.999, 192, 128),
      makeEarthMaterial(load('earth-blue-marble.jpg'), load('earth-night.jpg'), this.sunDir),
    );
    this.scene.add(this.earth);
    this.tiles = new EarthTiles(this.earth, this.sunDir, this.renderer.capabilities.getMaxAnisotropy());

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.025, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { sunDir: { value: this.sunDir } },
        vertexShader: atmosphereVertex,
        fragmentShader: atmosphereFragment,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.scene.add(atmosphere);

    // Lights and reflections only affect the spacecraft models; the Earth shades itself.
    this.scene.add(this.sunLight, new THREE.HemisphereLight('#b8d4ff', '#2b4a7a', 1.2));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();

    const sky = load('night-sky.png');
    sky.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = sky;
    this.scene.backgroundIntensity = 0.5;

    // Multisampled target so the phosphor path keeps the same antialiasing as direct rendering.
    this.composer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
    );
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new ShaderPass(PhosphorShader));
    this.composer.addPass(new OutputPass());

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      this.renderer.setSize(w, h);
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(container);
    resize();
  }

  /** Rotate the Earth and move the sun to match the simulated time. */
  setTime(date: Date) {
    this.earth.rotation.y = gstime(date);
    const { rsun } = sunPos(jday(date));
    eciToScene(rsun.x, rsun.y, rsun.z, this.tmp);
    this.sunDir.copy(this.tmp.normalize());
    this.sunLight.position.copy(this.sunDir).multiplyScalar(50);
  }

  render() {
    this.tiles.update(this.camera, this.renderer.domElement.clientHeight);
    // Keep the near plane proportional to the zoom so close-ups neither clip nor lose depth precision.
    const near = THREE.MathUtils.clamp(this.camera.position.distanceTo(this.controls.target) * 0.02, 0.0002, 0.05);
    if (Math.abs(near - this.camera.near) > near * 0.1) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    if (this.mode === 'phosphor') this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  get visualMode() {
    return this.mode;
  }

  setVisualMode(mode: VisualMode) {
    this.mode = mode;
    phosphorUniform.value = mode === 'phosphor' ? 1 : 0;
  }
}
