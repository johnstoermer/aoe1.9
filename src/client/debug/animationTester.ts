import * as THREE from 'three';
import { UNITS } from '../../shared/data';
import type { UnitTypeId } from '../../shared/types';
import {
  applyTeamColor, getAnimationClips, instantiate, loadAnimationLibrary, loadModel,
} from '../assets';
import { findHandSlot, modelPathFor, fitTo } from '../render/units';
import { UNIT_VISUALS } from '../visuals';
import { el, makeWindow } from '../ui/widgets';

const CHARACTERS = (Object.keys(UNITS) as UnitTypeId[]).filter((type) => type !== 'catapult');
const WEAPONS = [
  ['None', ''],
  ['Sword (1H)', '/assets/models/weapons/sword_1handed.gltf'],
  ['Bow', '/assets/models/weapons/bow_withString.gltf'],
  ['Crossbow (2H)', '/assets/models/weapons/crossbow_2handed.gltf'],
  ['Large Axe (2H)', '/assets/models/weapons/axe_2handed_Large.gltf'],
  ['Hammer', '/assets/models/weapons/hammer_A.gltf'],
] as const;

export function showAnimationTester(onBack: () => void): () => void {
  const screen = el('div', { class: 'screen desktop animation-tester-screen' }) as HTMLDivElement;
  document.getElementById('ui-root')!.appendChild(screen);
  const win = makeWindow('Character Animation & Equipment Tester', {
    width: 900, onClose: onBack, draggable: false, className: 'animation-tester-window',
  });

  const canvas = el('canvas', { class: 'animation-tester-canvas' }) as HTMLCanvasElement;
  canvas.width = 640;
  canvas.height = 430;
  const controls = el('div', { class: 'animation-tester-controls' });
  const character = labeledSelect('Character', CHARACTERS.map((type) => [type, UNITS[type].name]));
  const animation = labeledSelect('Animation', []);
  const weaponOptions: [string, string][] = [['auto', 'Mapped weapon']];
  for (const [name, path] of WEAPONS) weaponOptions.push([path, name]);
  const weapon = labeledSelect('Weapon', weaponOptions);
  const hand = labeledSelect('Attach to', [['right', 'Right hand'], ['left', 'Left hand']]);
  const speed = el('input', { type: 'range', min: '0', max: '200', value: '100' }) as HTMLInputElement;
  const speedValue = el('span', { text: '1.00×' });
  const speedRow = el('div', { class: 'tester-field' }, el('label', { text: 'Playback speed' }), speed, speedValue);
  const status = el('div', { class: 'sunken-panel tester-status', text: 'Loading production animation library…' });
  const play = el('button', { text: 'Pause' });
  const reset = el('button', { text: 'Reset Pose' });
  const back = el('button', { text: 'Back' });
  controls.append(character.row, animation.row, weapon.row, hand.row, speedRow, play, reset, status, back);
  win.body.append(canvas, controls);
  screen.appendChild(win.root);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(640, 430, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x31525e);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x29351f, 2.2));
  const key = new THREE.DirectionalLight(0xfff0d0, 2.5);
  key.position.set(3, 5, 4);
  scene.add(key);
  const grid = new THREE.GridHelper(8, 16, 0x8aa0a0, 0x506868);
  scene.add(grid);
  const camera = new THREE.PerspectiveCamera(35, 640 / 430, 0.01, 100);
  camera.position.set(2.8, 1.8, 4.4);
  camera.lookAt(0, 0.8, 0);

  const pivot = new THREE.Group();
  scene.add(pivot);
  let characterObject: THREE.Group | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let action: THREE.AnimationAction | null = null;
  let playing = true;
  let disposed = false;
  let requestId = 0;
  let raf = 0;
  let last = performance.now();

  const loadCharacter = async () => {
    const currentRequest = ++requestId;
    const type = character.select.value as UnitTypeId;
    status.textContent = `Loading ${UNITS[type].name}…`;
    const model = await loadModel(modelPathFor(type, 0, 0));
    if (disposed || currentRequest !== requestId) return;
    if (characterObject) pivot.remove(characterObject);
    characterObject = instantiate(model, true);
    applyTeamColor(characterObject, type, 0);
    fitTo(characterObject, UNIT_VISUALS[type].height * 2.35, true);
    pivot.add(characterObject);
    mixer = new THREE.AnimationMixer(characterObject);
    await attachWeapon(type, characterObject, weapon.select.value, hand.select.value);
    playAnimation();
  };

  const attachWeapon = async (type: UnitTypeId, object: THREE.Object3D, selected: string, side: string) => {
    object.traverse((child) => {
      if (child.userData.debugWeapon) child.parent?.remove(child);
    });
    const path = selected === 'auto' ? UNIT_VISUALS[type].weapon ?? '' : selected;
    const slotName = side === 'left' ? 'handslot.l' : 'handslot.r';
    const fallbackName = side === 'left' ? 'hand.l' : 'hand.r';
    const slot = findHandSlot(object, side === 'left' ? 'left' : 'right');
    if (!path) {
      status.textContent = `${UNITS[type].name}: no weapon selected. ${slot ? `Found ${slot.name}.` : 'Hand slot missing.'}`;
      return;
    }
    if (!slot) {
      status.textContent = `${UNITS[type].name}: ${slotName} and ${fallbackName} are missing.`;
      return;
    }
    const weaponModel = await loadModel(path);
    const equipment = instantiate(weaponModel, false);
    equipment.userData.debugWeapon = true;
    slot.add(equipment);
    status.textContent = `${UNITS[type].name}: ${path.split('/').pop()} attached to ${slot.name}.`;
  };

  const playAnimation = () => {
    if (!mixer) return;
    mixer.stopAllAction();
    const clip = getAnimationClips().find((candidate) => candidate.name === animation.select.value);
    if (!clip) return;
    action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity).play();
    action.paused = !playing;
  };

  void loadAnimationLibrary().then(() => {
    for (const clip of getAnimationClips()) animation.select.appendChild(el('option', { value: clip.name, text: clip.name }));
    animation.select.value = 'Idle_A';
    void loadCharacter();
  }).catch((error) => { status.textContent = `Load failed: ${String(error)}`; });

  character.select.addEventListener('change', () => void loadCharacter());
  animation.select.addEventListener('change', playAnimation);
  weapon.select.addEventListener('change', () => { if (characterObject) void attachWeapon(character.select.value as UnitTypeId, characterObject, weapon.select.value, hand.select.value); });
  hand.select.addEventListener('change', () => { if (characterObject) void attachWeapon(character.select.value as UnitTypeId, characterObject, weapon.select.value, hand.select.value); });
  speed.addEventListener('input', () => { speedValue.textContent = `${(Number(speed.value) / 100).toFixed(2)}×`; });
  play.addEventListener('click', () => {
    playing = !playing;
    if (action) action.paused = !playing;
    play.textContent = playing ? 'Pause' : 'Play';
  });
  reset.addEventListener('click', () => { pivot.rotation.set(0, 0, 0); playAnimation(); });
  back.addEventListener('click', onBack);

  let dragX: number | null = null;
  canvas.addEventListener('pointerdown', (event) => { dragX = event.clientX; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', (event) => {
    if (dragX === null) return;
    pivot.rotation.y += (event.clientX - dragX) * 0.012;
    dragX = event.clientX;
  });
  canvas.addEventListener('pointerup', () => { dragX = null; });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    camera.position.multiplyScalar(event.deltaY > 0 ? 1.08 : 0.92);
    camera.lookAt(0, 0.8, 0);
  }, { passive: false });

  const frame = (now: number) => {
    if (disposed) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    mixer?.update(dt * Number(speed.value) / 100);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    renderer.dispose();
    screen.remove();
  };
}

function labeledSelect(label: string, options: (readonly [string, string])[]) {
  const select = el('select') as HTMLSelectElement;
  for (const [value, text] of options) select.appendChild(el('option', { value, text }));
  const row = el('div', { class: 'tester-field' }, el('label', { text: label }), select);
  return { row, select };
}
