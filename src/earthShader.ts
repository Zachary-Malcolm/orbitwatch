import * as THREE from 'three';

// Day/night Earth shading shared by the base globe and the high-resolution tiles.
// Lights city lights on the night side, adds a sun glint on water and a blue haze toward the limb.
// In phosphor mode (see scene.ts) it also darkens the oceans and draws a 15° lat/long grid; the
// amber colouring itself is applied to the whole frame by a post-processing pass.

/** Shared by every Earth material so the visual mode flips with one assignment. */
export const phosphorUniform = { value: 1 };

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying vec3 vLocalNormal;
  void main() {
    vUv = uv;
    vLocalNormal = normal;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform vec3 sunDir;
  uniform float phosphor;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying vec3 vLocalNormal;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float light = dot(N, sunDir);
    float dayMix = smoothstep(-0.12, 0.18, light);

    vec3 albedo = texture2D(dayMap, vUv).rgb;
    vec3 day = albedo * (0.35 + 0.85 * max(light, 0.0));

    // Water is blue-dominant and dark in the imagery (checked in approximate sRGB space).
    vec3 s = sqrt(albedo);
    float water = clamp((s.b - max(s.r, s.g)) * 5.0, 0.0, 1.0) * (1.0 - smoothstep(0.35, 0.6, dot(s, vec3(0.333))));
    float glint = pow(max(dot(N, normalize(sunDir + V)), 0.0), 90.0) * water * max(light, 0.0);
    day += vec3(1.0, 0.9, 0.75) * glint * 0.9;

    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    day = mix(day, vec3(0.42, 0.62, 1.0), rim * 0.25 * dayMix);

    // Keep only the city lights: NASA's night imagery also carries faint moonlit terrain.
    vec3 nightTex = texture2D(nightMap, vUv).rgb;
    float lum = dot(nightTex, vec3(0.3, 0.59, 0.11));
    vec3 night = nightTex * smoothstep(0.012, 0.15, lum) * 1.8 + vec3(0.003, 0.006, 0.016);
    vec3 color = mix(night, day, dayMix);

    if (phosphor > 0.5) {
      // Oceans recede so coastlines read clearly once the frame is monochrome.
      color *= 1.0 - 0.7 * water;
      vec3 n = normalize(vLocalNormal);
      vec2 deg = vec2(degrees(atan(-n.z, n.x)), degrees(asin(clamp(n.y, -1.0, 1.0)))) / 15.0;
      vec2 dist = abs(fract(deg - 0.5) - 0.5) / max(fwidth(deg), 1e-4);
      float line = 1.0 - min(min(dist.x, dist.y), 1.0);
      color += vec3(0.16) * line;
    }
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function makeEarthMaterial(dayMap: THREE.Texture, nightMap: THREE.Texture, sunDir: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      sunDir: { value: sunDir },
      phosphor: phosphorUniform,
    },
    vertexShader,
    fragmentShader,
  });
}
