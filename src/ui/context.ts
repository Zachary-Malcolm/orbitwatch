import { GlobeScene } from '../scene';
import { ModelLayer } from '../models';
import { GroundTrack, type Coverage } from '../groundTrack';
import { ObserverMarker } from '../observer';
import type { SatelliteLayer } from '../satellites';
import { $ } from './dom';

// The 3D scene and the state the UI modules share.

export const globe = new GlobeScene($('globe'));
export const canvas = globe.renderer.domElement;
export const models = new ModelLayer(globe.scene);
export const groundTrack = new GroundTrack(globe.earth);
export const observerMarker = new ObserverMarker(globe.scene, globe.earth);

export const app = {
  /** Every tracked object; null until the catalogue has loaded. */
  layer: null as SatelliteLayer | null,
  /** The locked target's coverage footprint, updated each frame. */
  coverage: null as Coverage | null,
  /** Catalogue index by NORAD ID, for shared links. */
  byNorad: new Map<string, number>(),
};
