import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import "./style.css";
import { CARS, LEVELS, type CarConfig, type LevelConfig, type ObstacleConfig } from "./data";

type Gear = 1 | -1;
type ControlName = "left" | "right" | "throttle" | "brake" | "handbrake";

interface RunState {
  x: number;
  z: number;
  heading: number;
  speed: number;
  steer: number;
  gear: Gear;
  elapsed: number;
  penalty: number;
  damage: number;
  hits: number;
  hold: number;
  accuracy: number;
  finished: boolean;
}

interface SaveData {
  version: 1;
  car: number;
  level: number;
  assists: boolean;
  muted: boolean;
  best: Record<string, number>;
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerpAngle = (a: number, b: number, t: number) => {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
};
const angleDifference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const parkingAngleDifference = (a: number, b: number) => Math.min(angleDifference(a, b), angleDifference(a, b + Math.PI));
const formatTime = (seconds: number, compact = false) => {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (compact) return `${minutes}:${secs.toString().padStart(2, "0")}`;
  const tenths = Math.floor((seconds % 1) * 10);
  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${tenths}`;
};

const defaultSave = (): SaveData => ({ version: 1, car: 0, level: 0, assists: true, muted: false, best: {} });

class SoundSystem {
  private context?: AudioContext;
  private engine?: OscillatorNode;
  private engineGain?: GainNode;
  private lastSensorBeep = 0;
  muted = false;

  ensure() {
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume();
      return;
    }
    const AudioContextCtor = window.AudioContext;
    this.context = new AudioContextCtor();
    this.engine = this.context.createOscillator();
    this.engine.type = "sawtooth";
    this.engineGain = this.context.createGain();
    this.engineGain.gain.value = 0;
    this.engine.connect(this.engineGain).connect(this.context.destination);
    this.engine.start();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted && this.engineGain && this.context) {
      this.engineGain.gain.setTargetAtTime(0, this.context.currentTime, .03);
    }
  }

  updateEngine(speed: number, driving: boolean) {
    if (!this.context || !this.engine || !this.engineGain) return;
    const now = this.context.currentTime;
    const intensity = clamp(Math.abs(speed) / 9, 0, 1);
    this.engine.frequency.setTargetAtTime(48 + intensity * 92, now, .08);
    this.engineGain.gain.setTargetAtTime(this.muted || !driving ? 0 : .018 + intensity * .022, now, .08);
  }

  tone(frequency: number, duration = .09, volume = .055, type: OscillatorType = "sine") {
    if (!this.context || this.muted) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  collision() {
    this.tone(92, .18, .11, "square");
    window.setTimeout(() => this.tone(62, .12, .07, "sawtooth"), 35);
  }

  success() {
    [440, 554, 659].forEach((frequency, index) => window.setTimeout(() => this.tone(frequency, .23, .07), index * 115));
  }

  sensor(distance: number, nowMs: number) {
    if (!this.context || this.muted || distance > 3.1) return;
    const interval = clamp(distance * 240, 100, 680);
    if (nowMs - this.lastSensorBeep > interval) {
      this.tone(distance < .75 ? 950 : 720, .055, .032);
      this.lastSensorBeep = nowMs;
    }
  }
}

class ParkingGame {
  private canvas = $("#game-canvas") as HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, .1, 240);
  private rearCamera = new THREE.PerspectiveCamera(62, 2.35, .08, 160);
  private clock = new THREE.Clock();
  private accumulator = 0;
  private lastFrame = 0;
  private carGroup = new THREE.Group();
  private carWheels: THREE.Object3D[] = [];
  private frontWheels: THREE.Object3D[] = [];
  private brakeLights: THREE.MeshStandardMaterial[] = [];
  private reverseLight?: THREE.SpotLight;
  private targetGroup = new THREE.Group();
  private targetMaterial?: THREE.MeshStandardMaterial;
  private guideLine?: THREE.Line;
  private guideArrow?: THREE.Group;
  private garageRoof?: THREE.Group;
  private obstacles: ObstacleConfig[] = [];
  private obstacleMeshes: THREE.Object3D[] = [];
  private currentCar = CARS[0];
  private currentLevel = LEVELS[0];
  private selectedCar = 0;
  private selectedLevel = 0;
  private state: RunState = this.freshState();
  private controls: Record<ControlName, boolean> = { left: false, right: false, throttle: false, brake: false, handbrake: false };
  private activeControlPointers = new Map<number, { name: ControlName; button: HTMLButtonElement }>();
  private assists = true;
  private paused = false;
  private inGame = false;
  private cameraMode = 0;
  private collisionCooldown = 0;
  private toastTimeout = 0;
  private rotateNoticeTimeout = 0;
  private previewAngle = -.55;
  private resultSuccess = false;
  private sound = new SoundSystem();
  private save: SaveData;
  private cameraTarget = new THREE.Vector3();
  private cameraPosition = new THREE.Vector3();
  private rearCameraTarget = new THREE.Vector3();
  private tmpVec = new THREE.Vector3();
  private tmpSide = new THREE.Vector3();

  private ui = {
    app: $("#app"),
    garage: $("#garage-screen"),
    game: $("#game-screen"),
    pause: $("#pause-modal"),
    result: $("#result-modal"),
    carPicker: $("#car-picker"),
    levelPicker: $("#level-picker"),
    carName: $("#selected-car-name"),
    levelName: $("#selected-level-name"),
    specs: $("#car-specs"),
    assistToggle: $("#assist-toggle") as HTMLButtonElement,
    assistLabel: $("#assist-label"),
    start: $("#start-button") as HTMLButtonElement,
    objectiveIndex: $("#objective-index"),
    objectiveTitle: $("#objective-title"),
    objectiveHint: $("#objective-hint"),
    timer: $("#timer"),
    penalty: $("#penalty"),
    speed: $("#speed"),
    accuracy: $("#accuracy"),
    steering: $("#steering-indicator"),
    sensor: $("#sensor-banner"),
    sensorText: $("#sensor-text"),
    rearView: $("#rear-view-monitor"),
    cockpit: $("#cockpit-overlay"),
    hintButton: $("#hint-button") as HTMLButtonElement,
    toast: $("#toast"),
    rain: $("#rain-layer"),
    rotateNotice: $(".rotate-device"),
    resultEyebrow: $("#result-eyebrow"),
    resultTitle: $("#result-title"),
    resultStars: $("#result-stars"),
    resultScore: $("#result-score"),
    resultAccuracy: $("#result-accuracy"),
    resultTime: $("#result-time"),
    resultHits: $("#result-hits"),
    bestBadge: $("#best-badge"),
    nextButton: $("#next-button") as HTMLButtonElement,
    sound: $("#sound-toggle") as HTMLButtonElement,
  };

  constructor() {
    try {
      const parsed = JSON.parse(localStorage.getItem("park-shift-save") || "null") as SaveData | null;
      this.save = parsed?.version === 1 ? parsed : defaultSave();
    } catch {
      this.save = defaultSave();
    }
    this.selectedCar = clamp(this.save.car, 0, CARS.length - 1);
    this.selectedLevel = clamp(this.save.level, 0, LEVELS.length - 1);
    this.assists = this.save.assists;
    this.sound.setMuted(this.save.muted);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.bindUI();
    this.renderPickers();
    this.buildGarage();
    this.updateAssistUI();
    this.ui.sound.textContent = this.sound.muted ? "×" : "♪";
    this.ui.sound.setAttribute("aria-pressed", String(this.sound.muted));
    this.clock.start();
    requestAnimationFrame(this.frame);
  }

  private freshState(): RunState {
    return { x: 0, z: 0, heading: 0, speed: 0, steer: 0, gear: 1, elapsed: 0, penalty: 0, damage: 0, hits: 0, hold: 0, accuracy: 0, finished: false };
  }

  private persist() {
    this.save.car = this.selectedCar;
    this.save.level = this.selectedLevel;
    this.save.assists = this.assists;
    this.save.muted = this.sound.muted;
    localStorage.setItem("park-shift-save", JSON.stringify(this.save));
  }

  private bindUI() {
    this.ui.start.addEventListener("click", () => this.startRun());
    this.ui.assistToggle.addEventListener("click", () => this.toggleAssists());
    $("#pause-button").addEventListener("click", () => this.pause());
    $("#resume-button").addEventListener("click", () => this.resume());
    $("#restart-button").addEventListener("click", () => this.startRun());
    $("#retry-button").addEventListener("click", () => this.startRun());
    $("#garage-button").addEventListener("click", () => this.openGarage());
    $("#result-garage-button").addEventListener("click", () => this.openGarage());
    $("#camera-button").addEventListener("click", () => this.switchCamera());
    this.ui.hintButton.addEventListener("click", () => this.toggleAssists());
    this.ui.nextButton.addEventListener("click", () => {
      if (!this.resultSuccess) {
        this.startRun();
        return;
      }
      this.selectedLevel = (this.selectedLevel + 1) % LEVELS.length;
      this.renderPickers();
      this.startRun();
    });
    this.ui.sound.addEventListener("click", () => {
      this.sound.ensure();
      this.sound.setMuted(!this.sound.muted);
      this.ui.sound.textContent = this.sound.muted ? "×" : "♪";
      this.ui.sound.setAttribute("aria-pressed", String(this.sound.muted));
      this.persist();
    });

    document.querySelectorAll<HTMLButtonElement>("[data-gear]").forEach((button) => {
      button.addEventListener("click", () => this.setGear(Number(button.dataset.gear) as Gear));
    });

    const keyControl: Record<string, ControlName> = {
      KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
      KeyW: "throttle", ArrowUp: "throttle", KeyS: "brake", ArrowDown: "brake", Space: "handbrake",
    };
    window.addEventListener("keydown", (event) => {
      const control = keyControl[event.code];
      if (control) {
        this.controls[control] = true;
        event.preventDefault();
      }
      if (event.repeat) return;
      if (event.code === "KeyR" && this.inGame && !this.paused) this.setGear(this.state.gear === 1 ? -1 : 1);
      if (event.code === "KeyC" && this.inGame) this.switchCamera();
      if (event.code === "KeyH" && this.inGame) this.toggleAssists();
      if ((event.code === "Escape" || event.code === "KeyP") && this.inGame && !this.state.finished) this.paused ? this.resume() : this.pause();
    });
    window.addEventListener("keyup", (event) => {
      const control = keyControl[event.code];
      if (control) this.controls[control] = false;
    });
    window.addEventListener("blur", () => this.releaseControls());
    window.addEventListener("pagehide", () => this.releaseControls());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.releaseControls();
    });

    const releasePointer = (event: PointerEvent) => this.releaseControlPointer(event.pointerId);
    window.addEventListener("pointerup", releasePointer, true);
    window.addEventListener("pointercancel", releasePointer, true);

    const mobileControls = $("#mobile-controls");
    ["selectstart", "contextmenu", "dragstart"].forEach((eventName) => {
      mobileControls.addEventListener(eventName, (event) => event.preventDefault());
    });

    document.querySelectorAll<HTMLButtonElement>("[data-control]").forEach((button) => {
      const name = button.dataset.control as ControlName;
      const press = (event: PointerEvent) => {
        event.preventDefault();
        event.stopPropagation();
        this.sound.ensure();
        this.releaseControlPointer(event.pointerId);
        this.activeControlPointers.set(event.pointerId, { name, button });
        try { button.setPointerCapture(event.pointerId); } catch { /* Safari can reject capture during interrupted gestures. */ }
        this.controls[name] = true;
        button.classList.add("pressed");
        if (navigator.vibrate) navigator.vibrate(8);
      };
      const release = (event: PointerEvent) => {
        event.preventDefault();
        this.releaseControlPointer(event.pointerId);
      };
      const move = (event: PointerEvent) => {
        if (!this.activeControlPointers.has(event.pointerId)) return;
        const rect = button.getBoundingClientRect();
        const tolerance = 28;
        if (
          event.clientX < rect.left - tolerance || event.clientX > rect.right + tolerance
          || event.clientY < rect.top - tolerance || event.clientY > rect.bottom + tolerance
        ) this.releaseControlPointer(event.pointerId);
      };
      button.addEventListener("pointerdown", press);
      button.addEventListener("pointermove", move);
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", releasePointer);
    });

    window.addEventListener("resize", this.resize);
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.showToast("Графика приостановлена. Восстанавливаем сцену…");
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.inGame ? this.buildLevel() : this.buildGarage();
      this.showToast("Сцена восстановлена");
    });
  }

  private releaseControlPointer(pointerId: number) {
    const active = this.activeControlPointers.get(pointerId);
    if (!active) return;

    this.activeControlPointers.delete(pointerId);
    const sameControlStillPressed = [...this.activeControlPointers.values()].some(({ name }) => name === active.name);
    const sameButtonStillPressed = [...this.activeControlPointers.values()].some(({ button }) => button === active.button);
    this.controls[active.name] = sameControlStillPressed;
    if (!sameButtonStillPressed) active.button.classList.remove("pressed");

    try {
      if (active.button.hasPointerCapture(pointerId)) active.button.releasePointerCapture(pointerId);
    } catch { /* The browser may already have cancelled the pointer. */ }
  }

  private releaseControls() {
    const activePointers = [...this.activeControlPointers.entries()];
    this.activeControlPointers.clear();
    Object.keys(this.controls).forEach((key) => { this.controls[key as ControlName] = false; });
    document.querySelectorAll(".pressed").forEach((node) => node.classList.remove("pressed"));
    activePointers.forEach(([pointerId, { button }]) => {
      try {
        if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
      } catch { /* Pointer capture is already gone. */ }
    });
  }

  private renderPickers() {
    this.currentCar = CARS[this.selectedCar];
    this.currentLevel = LEVELS[this.selectedLevel];
    this.ui.carName.textContent = this.currentCar.name;
    this.ui.levelName.textContent = this.currentLevel.name;
    this.ui.carPicker.replaceChildren();
    CARS.forEach((car, index) => {
      const button = document.createElement("button");
      button.className = `car-option${index === this.selectedCar ? " active" : ""}`;
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(index === this.selectedCar));
      button.innerHTML = `<small>${car.className}</small><strong><i style="background:#${car.color.toString(16).padStart(6, "0")}"></i>${car.name}</strong>`;
      button.addEventListener("click", () => {
        this.selectedCar = index;
        this.renderPickers();
        this.buildGarage();
        this.persist();
      });
      this.ui.carPicker.append(button);
    });

    this.ui.levelPicker.replaceChildren();
    LEVELS.forEach((level, index) => {
      const button = document.createElement("button");
      button.className = `level-option${index === this.selectedLevel ? " active" : ""}`;
      button.type = "button";
      button.dataset.index = String(index + 1).padStart(2, "0");
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(index === this.selectedLevel));
      button.innerHTML = `<strong>${level.shortName}</strong><small>${level.conditionLabel} · ${level.difficulty}</small>`;
      button.addEventListener("click", () => {
        this.selectedLevel = index;
        this.renderPickers();
        this.persist();
      });
      this.ui.levelPicker.append(button);
    });

    const ratings = [
      ["МАНЁВРЕННОСТЬ", this.currentCar.handling],
      ["ГАБАРИТЫ", this.currentCar.sizeRating],
      ["СЛОЖНОСТЬ", this.currentCar.difficulty],
    ] as const;
    this.ui.specs.innerHTML = ratings.map(([label, rating]) => `<div class="car-spec"><small>${label}</small><strong>${rating}/5</strong><span class="mini-bars">${[1,2,3,4,5].map((value) => `<i class="${value <= rating ? "on" : ""}"></i>`).join("")}</span></div>`).join("");
  }

  private updateAssistUI() {
    this.ui.assistToggle.setAttribute("aria-pressed", String(this.assists));
    this.ui.assistToggle.querySelector("span")!.textContent = this.assists ? "С подсказками" : "Без подсказок";
    this.ui.assistLabel.textContent = this.assists ? "Учебный" : "Эксперт";
    this.ui.hintButton.classList.toggle("active", this.assists);
    if (this.guideLine) this.guideLine.visible = this.assists;
    if (this.guideArrow) this.guideArrow.visible = this.assists;
    if (this.targetMaterial) {
      this.targetMaterial.opacity = this.assists ? .25 : .065;
      this.targetMaterial.emissiveIntensity = this.assists ? .65 : .12;
    }
  }

  private toggleAssists() {
    this.assists = !this.assists;
    this.updateAssistUI();
    this.persist();
    if (this.inGame) this.showToast(this.assists ? "Учебные подсказки включены" : "Экспертный режим: подсказки скрыты");
  }

  private buildGarage() {
    this.inGame = false;
    this.currentCar = CARS[this.selectedCar];
    this.currentLevel = LEVELS[this.selectedLevel];
    this.resetScene(0x0a1518, 0x0a1518, .018);
    this.addLighting(false, false);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(15, 64),
      new THREE.MeshStandardMaterial({ color: 0x172124, roughness: .7, metalness: .15 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    for (let radius = 4; radius <= 12; radius += 4) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius - .015, radius + .015, 64),
        new THREE.MeshBasicMaterial({ color: 0x536466, transparent: true, opacity: .22, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = .012;
      this.scene.add(ring);
    }

    this.carGroup = this.createCarModel(this.currentCar, this.currentCar.color);
    this.carGroup.position.set(2.8, 0, 0);
    this.carGroup.rotation.y = this.previewAngle;
    this.scene.add(this.carGroup);
    const shadowDisc = new THREE.Mesh(new THREE.CircleGeometry(3.4, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .18, depthWrite: false }));
    shadowDisc.rotation.x = -Math.PI / 2;
    shadowDisc.position.set(2.8, .02, 0);
    this.scene.add(shadowDisc);

    this.camera.position.set(10.8, 5.4, 11.8);
    this.camera.lookAt(2.8, .7, 0);
    this.cameraPosition.copy(this.camera.position);
    this.cameraTarget.set(2.8, .7, 0);
    this.ui.rain.classList.remove("active");
  }

  private startRun() {
    this.sound.ensure();
    this.currentCar = CARS[this.selectedCar];
    this.currentLevel = LEVELS[this.selectedLevel];
    this.state = this.freshState();
    Object.assign(this.state, this.currentLevel.spawn);
    this.cameraMode = 0;
    this.collisionCooldown = 0;
    this.resultSuccess = false;
    this.inGame = true;
    this.paused = false;
    this.releaseControls();
    this.buildLevel();
    this.ui.garage.classList.remove("active");
    this.ui.game.classList.add("active");
    this.ui.pause.classList.remove("open");
    this.ui.result.classList.remove("open");
    this.ui.app.classList.add("in-game");
    window.clearTimeout(this.rotateNoticeTimeout);
    this.ui.rotateNotice.classList.add("visible");
    this.rotateNoticeTimeout = window.setTimeout(() => this.ui.rotateNotice.classList.remove("visible"), 3200);
    this.ui.objectiveIndex.textContent = String(this.selectedLevel + 1).padStart(2, "0");
    this.ui.objectiveTitle.textContent = this.currentLevel.objective;
    this.ui.objectiveHint.textContent = this.assists ? this.currentLevel.hint : "Подсказки скрыты. Ориентируйтесь по разметке и зеркалам.";
    this.ui.timer.textContent = "00:00.0";
    this.ui.penalty.textContent = "0";
    this.ui.speed.textContent = "0";
    this.ui.accuracy.textContent = "—";
    this.updateGearUI();
    this.persist();
    this.showToast(this.assists ? "Следуйте к выделенному месту" : "Экспертный заезд · бонус +100");
  }

  private buildLevel() {
    const level = this.currentLevel;
    this.resetScene(level.night ? 0x02070c : level.garage ? 0x111719 : 0x8aa7a4, level.night ? 0x040b12 : 0x879c97, level.garage ? .035 : level.night ? .025 : .011);
    this.addLighting(Boolean(level.night), Boolean(level.garage));

    const groundMaterial = new THREE.MeshStandardMaterial({
      color: level.garage ? 0x252a2a : level.night ? 0x172124 : 0x4e5a57,
      roughness: level.rain ? .33 : .86,
      metalness: level.rain ? .38 : .05,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(level.worldSize, level.worldSize), groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.addWorldDetails(level);
    this.obstacles = [...level.obstacles];
    this.obstacleMeshes = [];
    for (const obstacle of this.obstacles) this.addObstacle(obstacle);
    this.addParkingZone(level);

    this.carGroup = this.createCarModel(this.currentCar, this.currentCar.color);
    this.carGroup.position.set(this.state.x, 0, this.state.z);
    this.carGroup.rotation.y = this.state.heading;
    this.scene.add(this.carGroup);
    this.addReverseLight();
    if (level.night) this.addHeadlights();

    this.camera.position.set(this.state.x - 8 * Math.sin(this.state.heading), 4.7, this.state.z - 8 * Math.cos(this.state.heading));
    this.cameraTarget.set(this.state.x, 1, this.state.z);
    this.cameraPosition.copy(this.camera.position);
    this.ui.rain.classList.toggle("active", Boolean(level.rain));
    this.updateAssistUI();
  }

  private resetScene(background: number, fogColor: number, fogDensity: number) {
    this.scene.clear();
    this.scene.background = new THREE.Color(background);
    this.scene.fog = new THREE.FogExp2(fogColor, fogDensity);
    this.carWheels = [];
    this.frontWheels = [];
    this.brakeLights = [];
    this.reverseLight = undefined;
    this.targetGroup = new THREE.Group();
    this.targetMaterial = undefined;
    this.guideLine = undefined;
    this.guideArrow = undefined;
    this.garageRoof = undefined;
  }

  private addLighting(night: boolean, garage: boolean) {
    const hemisphere = new THREE.HemisphereLight(night ? 0x385273 : 0xdcebea, night ? 0x09100f : 0x29302d, night ? .65 : garage ? 1.15 : 1.8);
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(night ? 0x7994ba : 0xfff1d8, night ? .55 : 2.15);
    sun.position.set(-12, 22, -8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -25;
    sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -25;
    sun.shadow.bias = -.0008;
    this.scene.add(sun);
    if (garage) {
      for (let x = -10; x <= 10; x += 5) {
        const strip = new THREE.RectAreaLight(0xdffbff, 1.7, 3.2, .16);
        strip.position.set(x, 3.5, 2);
        strip.rotation.x = -Math.PI / 2;
        this.scene.add(strip);
      }
    }
  }

  private createCarModel(config: CarConfig, color: number, simplified = false) {
    const group = new THREE.Group();
    group.name = `${config.id}-car-model`;

    const isSuv = config.id === "suv";
    const isSedan = config.id === "sedan";
    const paintColor = new THREE.Color(color);
    const bodyMaterial = new THREE.MeshPhysicalMaterial({ color: paintColor, roughness: .2, metalness: .48, clearcoat: .82, clearcoatRoughness: .16 });
    const bodyShadeMaterial = new THREE.MeshPhysicalMaterial({ color: paintColor.clone().multiplyScalar(.72), roughness: .28, metalness: .42, clearcoat: .48, clearcoatRoughness: .24 });
    const trimMaterial = new THREE.MeshStandardMaterial({ color: 0x0d1315, roughness: .38, metalness: .35 });
    const softTrimMaterial = new THREE.MeshStandardMaterial({ color: 0x171e20, roughness: .78, metalness: .05 });
    const glassMaterial = new THREE.MeshPhysicalMaterial({ color: 0x253e49, roughness: .08, metalness: .18, transparent: true, opacity: .72, transmission: .16, thickness: .08 });
    const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x080a0b, roughness: .94, metalness: .02 });
    const rimMaterial = new THREE.MeshStandardMaterial({ color: 0xaeb9bb, roughness: .2, metalness: .9 });
    const brakeMaterial = new THREE.MeshStandardMaterial({ color: 0x30383a, roughness: .26, metalness: .85 });
    const caliperMaterial = new THREE.MeshStandardMaterial({ color: 0xd94338, roughness: .34, metalness: .32 });
    const chromeMaterial = new THREE.MeshStandardMaterial({ color: 0xc8d1d2, roughness: .15, metalness: .95 });
    const interiorMaterial = new THREE.MeshStandardMaterial({ color: 0x111719, roughness: .82, metalness: .04 });
    const headlightMaterial = new THREE.MeshPhysicalMaterial({ color: 0xeefcff, emissive: 0xcff6ff, emissiveIntensity: 1.7, roughness: .08, metalness: .06, transparent: true, opacity: .94 });
    const runningLightMaterial = new THREE.MeshBasicMaterial({ color: 0xe9ffff });
    const amberMaterial = new THREE.MeshStandardMaterial({ color: 0xffb547, emissive: 0xff8a22, emissiveIntensity: 1.25, roughness: .18 });
    const tailMaterialLeft = new THREE.MeshStandardMaterial({ color: 0xe32838, emissive: 0x9b0916, emissiveIntensity: .7, roughness: .2 });
    const tailMaterialRight = tailMaterialLeft.clone();
    const plateMaterial = new THREE.MeshBasicMaterial({ color: 0xe9eee5 });

    const place = <T extends THREE.Object3D>(object: T, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      object.position.set(x, y, z);
      object.rotation.set(rx, ry, rz);
      group.add(object);
      return object;
    };
    const rounded = (width: number, height: number, depth: number, material: THREE.Material, radius = .05) => {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, height, depth, simplified ? 2 : 4, radius), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };

    const wheelRadius = isSuv ? .41 : isSedan ? .355 : .35;
    const wheelWidth = isSuv ? .29 : .255;
    const wheelZ = config.wheelbase * .47;
    const shoulderHeight = isSuv ? .5 : .44;
    const shoulderY = isSuv ? .76 : .72;
    const roofY = config.height - .055;
    const greenhouseBottom = isSuv ? 1.0 : .94;
    const greenhouseHeight = Math.max(.37, roofY - greenhouseBottom);
    const greenhouseWidth = config.width * (isSuv ? .78 : .73);
    const greenhouseLength = config.length * (isSedan ? .43 : isSuv ? .46 : .45);
    const greenhouseZ = config.length * (isSedan ? -.055 : -.035);
    const hoodLength = config.length * (isSedan ? .29 : isSuv ? .26 : .25);
    const trunkLength = config.length * (isSedan ? .23 : isSuv ? .16 : .13);
    const hoodZ = config.length * .5 - hoodLength * .54;
    const trunkZ = -config.length * .5 + trunkLength * .56;

    place(rounded(config.width * .94, .28, config.length * .91, bodyShadeMaterial, .1), 0, .52, 0);
    place(rounded(config.width, shoulderHeight, config.length * .84, bodyMaterial, .13), 0, shoulderY, 0);
    place(rounded(config.width * .9, isSuv ? .24 : .19, hoodLength, bodyMaterial, .065), 0, isSuv ? 1.09 : 1.01, hoodZ);
    place(rounded(config.width * .88, isSedan ? .2 : .16, trunkLength, bodyMaterial, .055), 0, isSuv ? 1.08 : .99, trunkZ);

    const greenhouse = rounded(greenhouseWidth, greenhouseHeight, greenhouseLength, glassMaterial, .105);
    place(greenhouse, 0, greenhouseBottom + greenhouseHeight / 2, greenhouseZ);
    place(rounded(greenhouseWidth * .94, .095, greenhouseLength * .82, bodyMaterial, .035), 0, roofY, greenhouseZ - greenhouseLength * .035);

    const pillarY = greenhouseBottom + greenhouseHeight * .52;
    for (const side of [-1, 1]) {
      const x = side * greenhouseWidth * .51;
      for (const z of [greenhouseZ + greenhouseLength * .42, greenhouseZ, greenhouseZ - greenhouseLength * .42]) {
        place(rounded(.055, greenhouseHeight * .94, .075, trimMaterial, .018), x, pillarY, z);
      }
      place(rounded(.035, .045, greenhouseLength * .9, trimMaterial, .012), side * greenhouseWidth * .515, greenhouseBottom + .055, greenhouseZ);
    }

    const bumperWidth = config.width * .9;
    place(rounded(bumperWidth, .15, .13, trimMaterial, .035), 0, .47, config.length * .465);
    place(rounded(bumperWidth, .16, .13, trimMaterial, .035), 0, .46, -config.length * .465);
    place(rounded(config.width * .5, .19, .055, trimMaterial, .03), 0, .66, config.length * .473);
    place(rounded(config.width * .52, .12, .055, softTrimMaterial, .025), 0, .57, -config.length * .476);

    if (!simplified) {
      for (let index = -1; index <= 1; index += 1) {
        place(new THREE.Mesh(new THREE.BoxGeometry(config.width * .38, .018, .018), chromeMaterial), 0, .62 + index * .055, config.length * .504);
      }
      place(rounded(config.width * .38, .055, .045, softTrimMaterial, .018), 0, .42, config.length * .493);
    }

    for (const z of [-wheelZ, wheelZ]) {
      for (const side of [-1, 1]) {
        const x = side * config.width * .51;
        const pivot = new THREE.Group();
        pivot.position.set(x, wheelRadius, z);
        const roll = new THREE.Group();
        pivot.add(roll);

        const tire = new THREE.Mesh(new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, simplified ? 18 : 30, 2), tireMaterial);
        tire.rotation.z = Math.PI / 2;
        tire.castShadow = true;
        roll.add(tire);

        const rim = new THREE.Mesh(new THREE.CylinderGeometry(wheelRadius * .62, wheelRadius * .62, wheelWidth + .012, simplified ? 14 : 24), rimMaterial);
        rim.rotation.z = Math.PI / 2;
        roll.add(rim);

        const faceX = side * (wheelWidth * .53);
        const brakeDisc = new THREE.Mesh(new THREE.CylinderGeometry(wheelRadius * .44, wheelRadius * .44, .024, 24), brakeMaterial);
        brakeDisc.rotation.z = Math.PI / 2;
        brakeDisc.position.x = faceX;
        roll.add(brakeDisc);

        const hub = new THREE.Mesh(new THREE.CylinderGeometry(wheelRadius * .16, wheelRadius * .16, .04, 18), chromeMaterial);
        hub.rotation.z = Math.PI / 2;
        hub.position.x = faceX + side * .018;
        roll.add(hub);

        if (!simplified) {
          for (let spokeIndex = 0; spokeIndex < 5; spokeIndex += 1) {
            const spoke = new THREE.Mesh(new RoundedBoxGeometry(.035, wheelRadius * .11, wheelRadius * .76, 2, .012), rimMaterial);
            spoke.position.x = faceX + side * .025;
            spoke.rotation.x = (spokeIndex / 5) * Math.PI * 2;
            roll.add(spoke);
          }
          for (const ringX of [-wheelWidth * .5, wheelWidth * .5]) {
            const sidewallRing = new THREE.Mesh(new THREE.TorusGeometry(wheelRadius * .89, .018, 6, 28), tireMaterial);
            sidewallRing.rotation.y = Math.PI / 2;
            sidewallRing.position.x = ringX;
            roll.add(sidewallRing);
          }
          const caliper = rounded(.045, wheelRadius * .29, wheelRadius * .14, caliperMaterial, .016);
          caliper.position.set(faceX + side * .035, 0, wheelRadius * .27);
          pivot.add(caliper);
        }

        group.add(pivot);
        if (!simplified) {
          this.carWheels.push(roll);
          if (z > 0) this.frontWheels.push(pivot);
        }
      }
    }

    const lightWidth = config.width * (isSuv ? .22 : .2);
    for (const side of [-1, 1]) {
      const lightX = side * config.width * .31;
      place(rounded(lightWidth, isSuv ? .17 : .145, .055, headlightMaterial, .025), lightX, isSuv ? .88 : .82, config.length * .474);
      if (!simplified) {
        place(rounded(lightWidth * .72, .025, .018, runningLightMaterial, .009), lightX, isSuv ? .91 : .855, config.length * .506);
        place(rounded(.055, .055, .024, amberMaterial, .014), lightX + side * lightWidth * .34, isSuv ? .84 : .79, config.length * .505);
      }

      const tailMaterial = side < 0 ? tailMaterialLeft : tailMaterialRight;
      place(rounded(config.width * .2, isSuv ? .2 : .16, .055, tailMaterial, .025), lightX, isSuv ? .9 : .82, -config.length * .474);
      if (!simplified) place(rounded(config.width * .13, .028, .018, tailMaterial, .009), lightX, isSuv ? .94 : .85, -config.length * .505);
    }
    if (!simplified) this.brakeLights.push(tailMaterialLeft, tailMaterialRight);

    const plateFrame = rounded(.52, .19, .045, trimMaterial, .025);
    place(plateFrame, 0, .61, -config.length * .488);
    place(rounded(.43, .12, .02, plateMaterial, .012), 0, .61, -config.length * .516);
    if (!simplified) place(rounded(.4, .1, .02, plateMaterial, .01), 0, .62, config.length * .507);

    if (!simplified) {
      const doorZPositions = isSedan ? [greenhouseZ + greenhouseLength * .22, greenhouseZ - greenhouseLength * .27] : [greenhouseZ + greenhouseLength * .2, greenhouseZ - greenhouseLength * .24];
      for (const side of [-1, 1]) {
        const skinX = side * config.width * .502;
        for (const z of doorZPositions) {
          place(rounded(.024, .38, greenhouseLength * .42, bodyShadeMaterial, .018), skinX, .82, z);
          place(rounded(.035, .045, .2, chromeMaterial, .012), side * config.width * .516, 1.02, z - greenhouseLength * .1);
        }
        for (const seamZ of [greenhouseZ + greenhouseLength * .43, greenhouseZ, greenhouseZ - greenhouseLength * .44]) {
          place(new THREE.Mesh(new THREE.BoxGeometry(.027, .48, .022), trimMaterial), side * config.width * .513, .84, seamZ);
        }
        place(rounded(.055, .12, .25, bodyMaterial, .035), side * config.width * .55, 1.22 + (isSuv ? .08 : 0), greenhouseZ + greenhouseLength * .31);
        place(rounded(.018, .075, .16, glassMaterial, .015), side * config.width * .581, 1.22 + (isSuv ? .08 : 0), greenhouseZ + greenhouseLength * .275);
        place(rounded(.06, .08, config.length * .61, softTrimMaterial, .02), side * config.width * .505, .43, 0);
      }

      for (const seatX of [-config.width * .19, config.width * .19]) {
        place(rounded(.38, .43, .36, interiorMaterial, .06), seatX, 1.08, greenhouseZ - greenhouseLength * .07);
        place(rounded(.32, .18, .2, interiorMaterial, .05), seatX, 1.36, greenhouseZ - greenhouseLength * .13);
      }
      place(rounded(greenhouseWidth * .82, .13, .2, interiorMaterial, .035), 0, 1.13, greenhouseZ + greenhouseLength * .34);
      const steeringWheel = new THREE.Mesh(new THREE.TorusGeometry(.13, .022, 8, 20), softTrimMaterial);
      place(steeringWheel, config.width * .2, 1.23, greenhouseZ + greenhouseLength * .25, 0, 0, -.12);

      const exhaustCount = isSedan || isSuv ? 2 : 1;
      for (let index = 0; index < exhaustCount; index += 1) {
        const exhaustX = exhaustCount === 1 ? config.width * .3 : (index === 0 ? -1 : 1) * config.width * .31;
        const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(.045, .055, .18, 12), chromeMaterial);
        place(exhaust, exhaustX, .38, -config.length * .49, Math.PI / 2);
      }

      if (isSuv) {
        for (const side of [-1, 1]) place(rounded(.045, .065, greenhouseLength * .82, trimMaterial, .018), side * greenhouseWidth * .34, roofY + .085, greenhouseZ);
        place(rounded(config.width * .92, .13, config.length * .17, softTrimMaterial, .035), 0, .58, -config.length * .37);
      } else if (config.id === "hatch") {
        place(rounded(config.width * .72, .07, .24, bodyShadeMaterial, .025), 0, roofY + .035, greenhouseZ - greenhouseLength * .5);
      } else {
        place(rounded(config.width * .68, .055, .16, bodyShadeMaterial, .02), 0, 1.11, -config.length * .44);
      }

      const antenna = new THREE.Mesh(new THREE.ConeGeometry(.045, .12, 4), trimMaterial);
      place(antenna, 0, roofY + .09, greenhouseZ - greenhouseLength * .24);
    }

    return group;
  }

  private addHeadlights() {
    const target = new THREE.Object3D();
    target.position.set(0, .15, 9);
    this.carGroup.add(target);
    for (const x of [-.55, .55]) {
      const light = new THREE.SpotLight(0xd7f4ff, 22, 16, .34, .55, 1.2);
      light.position.set(x, .8, this.currentCar.length * .42);
      light.target = target;
      light.castShadow = false;
      this.carGroup.add(light);
    }
  }

  private addReverseLight() {
    const target = new THREE.Object3D();
    target.position.set(0, .08, -7);
    this.carGroup.add(target);
    const light = new THREE.SpotLight(0xe8f8ff, 0, 13, .58, .62, 1.35);
    light.position.set(0, .82, -this.currentCar.length * .42);
    light.target = target;
    light.castShadow = false;
    this.carGroup.add(light);
    this.reverseLight = light;
  }

  private addWorldDetails(level: LevelConfig) {
    const half = level.worldSize / 2;
    const stripeMaterial = new THREE.MeshBasicMaterial({ color: level.night ? 0x8f9e99 : 0xd4ddd3, transparent: true, opacity: level.night ? .5 : .72 });
    for (let x = -half + 4; x < half - 2; x += 3.6) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(.07, .015, 5.9), stripeMaterial);
      line.position.set(x, .012, 8);
      this.scene.add(line);
    }
    const curbMaterial = new THREE.MeshStandardMaterial({ color: 0x777d79, roughness: .9 });
    for (const side of [-1, 1]) {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(level.worldSize, .25, .55), curbMaterial);
      curb.position.set(0, .12, side * (half - .28));
      curb.receiveShadow = true;
      this.scene.add(curb);
    }

    if (level.garage) {
      const roof = new THREE.Group();
      roof.name = "garage-cutaway-roof";
      const ceiling = new THREE.Mesh(new THREE.BoxGeometry(level.worldSize, .35, level.worldSize), new THREE.MeshStandardMaterial({ color: 0x191e1f, roughness: .84 }));
      ceiling.position.y = 3.7;
      ceiling.receiveShadow = true;
      roof.add(ceiling);
      for (let z = -12; z <= 12; z += 6) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(level.worldSize, .35, .45), new THREE.MeshStandardMaterial({ color: 0x2f3535 }));
        beam.position.set(0, 3.35, z);
        roof.add(beam);
      }
      this.garageRoof = roof;
      this.scene.add(roof);
      this.updateGarageRoofVisibility();
      return;
    }

    const buildingMaterial = new THREE.MeshStandardMaterial({ color: level.night ? 0x101a23 : 0x586663, roughness: .88 });
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const radius = half + 7 + (i % 3) * 2;
      const width = 4 + (i % 4);
      const height = 3 + (i % 5) * 1.3;
      const building = new THREE.Mesh(new THREE.BoxGeometry(width, height, 4.5), buildingMaterial);
      building.position.set(Math.sin(angle) * radius, height / 2, Math.cos(angle) * radius);
      building.rotation.y = -angle;
      building.castShadow = true;
      building.receiveShadow = true;
      this.scene.add(building);
      if (level.night && i % 2 === 0) {
        const windowLight = new THREE.PointLight(0xffc978, 5, 8);
        windowLight.position.copy(building.position).add(new THREE.Vector3(0, height * .25, 0));
        this.scene.add(windowLight);
      }
    }

    for (let i = -1; i <= 1; i += 2) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.06, .09, 4.8, 8), new THREE.MeshStandardMaterial({ color: 0x252d2e, metalness: .7 }));
      pole.position.set(i * (half - 3), 2.4, -4);
      pole.castShadow = true;
      this.scene.add(pole);
      const lamp = new THREE.PointLight(level.night ? 0xb9e8ff : 0xffefd2, level.night ? 28 : 5, 13);
      lamp.position.set(i * (half - 3), 4.55, -4);
      this.scene.add(lamp);
    }
  }

  private addObstacle(obstacle: ObstacleConfig) {
    let object: THREE.Object3D;
    if (obstacle.kind === "car") {
      const parkedConfig = { ...CARS[1], width: obstacle.width, length: obstacle.length, height: obstacle.height || 1.5 };
      object = this.createCarModel(parkedConfig, obstacle.color ?? 0x667275, true);
    } else {
      const color = obstacle.kind === "pillar" ? 0xb7b7ad : obstacle.kind === "planter" ? 0x445948 : obstacle.kind === "barrier" ? 0xd6a43e : 0x858982;
      const material = new THREE.MeshStandardMaterial({ color, roughness: .82, metalness: obstacle.kind === "barrier" ? .2 : .02 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(obstacle.width, obstacle.height ?? 1, obstacle.length), material);
      mesh.position.y = (obstacle.height ?? 1) / 2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      object = mesh;
      if (obstacle.kind === "pillar") {
        const safety = new THREE.Mesh(new THREE.BoxGeometry(obstacle.width + .025, .25, obstacle.length + .025), new THREE.MeshBasicMaterial({ color: 0xffb547 }));
        safety.position.y = -.25;
        mesh.add(safety);
      }
      if (obstacle.kind === "planter") {
        const plant = new THREE.Mesh(new THREE.ConeGeometry(obstacle.width * .38, 1.6, 7), new THREE.MeshStandardMaterial({ color: 0x47684c, roughness: .9 }));
        plant.position.y = (obstacle.height ?? 1) / 2 + .8;
        mesh.add(plant);
      }
    }
    object.position.x = obstacle.x;
    object.position.z = obstacle.z;
    object.rotation.y = obstacle.rotation ?? 0;
    this.scene.add(object);
    this.obstacleMeshes.push(object);
  }

  private addParkingZone(level: LevelConfig) {
    const zone = level.zone;
    this.targetGroup = new THREE.Group();
    this.targetGroup.position.set(zone.x, .02, zone.z);
    this.targetGroup.rotation.y = zone.rotation;

    this.targetMaterial = new THREE.MeshStandardMaterial({
      color: 0xb9f34a,
      emissive: 0xb9f34a,
      emissiveIntensity: .65,
      transparent: true,
      opacity: .25,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(zone.width, zone.length), this.targetMaterial);
    fill.rotation.x = -Math.PI / 2;
    this.targetGroup.add(fill);
    const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xe7f2dd, transparent: true, opacity: .9 });
    const horizontal = new THREE.BoxGeometry(zone.width + .12, .025, .085);
    const vertical = new THREE.BoxGeometry(.085, .025, zone.length);
    for (const z of [-zone.length / 2, zone.length / 2]) {
      const line = new THREE.Mesh(horizontal, lineMaterial);
      line.position.z = z;
      this.targetGroup.add(line);
    }
    for (const x of [-zone.width / 2, zone.width / 2]) {
      const line = new THREE.Mesh(vertical, lineMaterial);
      line.position.x = x;
      this.targetGroup.add(line);
    }
    this.scene.add(this.targetGroup);

    const pathGeometry = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 28 }, () => new THREE.Vector3()));
    this.guideLine = new THREE.Line(pathGeometry, new THREE.LineBasicMaterial({ color: 0x55d8e7, transparent: true, opacity: .82 }));
    this.guideLine.frustumCulled = false;
    this.scene.add(this.guideLine);

    this.guideArrow = new THREE.Group();
    const arrowHead = new THREE.Mesh(new THREE.ConeGeometry(.45, 1.15, 4), new THREE.MeshStandardMaterial({ color: 0xb9f34a, emissive: 0xb9f34a, emissiveIntensity: 1.15 }));
    arrowHead.rotation.x = Math.PI;
    this.guideArrow.add(arrowHead);
    this.guideArrow.position.set(zone.x, 2.25, zone.z);
    this.scene.add(this.guideArrow);
  }

  private updateGuide() {
    if (!this.guideLine || !this.assists) return;
    const positions = this.guideLine.geometry.attributes.position as THREE.BufferAttribute;
    let x = this.state.x;
    let z = this.state.z;
    let heading = this.state.heading;
    const direction = this.state.gear;
    const steer = Math.abs(this.state.steer) < .035 ? 0 : this.state.steer;
    for (let i = 0; i < positions.count; i++) {
      positions.setXYZ(i, x, .06, z);
      heading += (direction * .24 / this.currentCar.wheelbase) * Math.tan(steer);
      x += Math.sin(heading) * direction * .24;
      z += Math.cos(heading) * direction * .24;
    }
    positions.needsUpdate = true;
  }

  private pause() {
    if (!this.inGame || this.state.finished) return;
    this.paused = true;
    this.releaseControls();
    this.ui.rotateNotice.classList.remove("visible");
    this.ui.pause.classList.add("open");
    this.updateViewPresentation();
  }

  private resume() {
    this.paused = false;
    this.ui.pause.classList.remove("open");
    this.clock.getDelta();
    this.updateViewPresentation();
  }

  private openGarage() {
    this.paused = false;
    this.inGame = false;
    this.releaseControls();
    window.clearTimeout(this.rotateNoticeTimeout);
    this.ui.rotateNotice.classList.remove("visible");
    this.ui.pause.classList.remove("open");
    this.ui.result.classList.remove("open");
    this.ui.game.classList.remove("active");
    this.ui.garage.classList.add("active");
    this.ui.app.classList.remove("in-game");
    this.updateViewPresentation();
    this.renderPickers();
    this.buildGarage();
  }

  private switchCamera() {
    this.cameraMode = (this.cameraMode + 1) % 4;
    this.updateGarageRoofVisibility();
    this.updateViewPresentation();
    const labels = ["Камера: сзади", "Камера: сверху", "Камера: капот", "Камера: из кабины"];
    this.showToast(labels[this.cameraMode]);
  }

  private updateGarageRoofVisibility() {
    if (!this.garageRoof) return;
    // Third-person and top views use a cutaway. During the transition to the
    // hood camera, restore the roof only after the camera is safely inside.
    this.garageRoof.visible = this.cameraMode >= 2 && this.camera.position.y < 3.1;
  }

  private isRearViewActive() {
    return this.inGame && !this.paused && !this.state.finished && this.state.gear === -1;
  }

  private updateViewPresentation() {
    const driving = this.inGame && !this.paused && !this.state.finished;
    const rearViewActive = driving && this.state.gear === -1;
    const cockpitActive = driving && this.cameraMode === 3;
    this.ui.rearView.classList.toggle("visible", rearViewActive);
    this.ui.rearView.setAttribute("aria-hidden", String(!rearViewActive));
    this.ui.cockpit.classList.toggle("visible", cockpitActive);
    this.ui.cockpit.setAttribute("aria-hidden", String(!cockpitActive));
    // The cockpit camera sits inside the player's car. Hide only its rendered
    // geometry to prevent roof/glass clipping while keeping headlights active.
    this.carGroup.traverse((object) => {
      if (object instanceof THREE.Mesh) object.visible = !cockpitActive;
    });
  }

  private setGear(gear: Gear) {
    if (Math.abs(this.state.speed) > .45) {
      this.showToast("Сначала полностью остановитесь");
      return;
    }
    this.state.gear = gear;
    this.state.speed = 0;
    this.updateGearUI();
    this.showToast(gear === 1 ? "Передача D · вперёд" : "Передача R · задний ход");
    this.sound.tone(330, .06, .035);
    if (navigator.vibrate) navigator.vibrate(7);
  }

  private updateGearUI() {
    document.querySelectorAll<HTMLButtonElement>("[data-gear]").forEach((button) => {
      const active = Number(button.dataset.gear) === this.state.gear;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (this.reverseLight) this.reverseLight.intensity = this.state.gear === -1 ? 18 : 0;
    this.updateViewPresentation();
  }

  private showToast(message: string, danger = false) {
    window.clearTimeout(this.toastTimeout);
    this.ui.toast.textContent = message;
    this.ui.toast.classList.toggle("danger", danger);
    this.ui.toast.classList.add("visible");
    this.toastTimeout = window.setTimeout(() => this.ui.toast.classList.remove("visible"), danger ? 2200 : 1800);
  }

  private frame = (time: number) => {
    requestAnimationFrame(this.frame);
    const delta = Math.min(this.clock.getDelta(), .05);
    if (!this.lastFrame) this.lastFrame = time;

    if (this.inGame && !this.paused && !this.state.finished) {
      this.accumulator += delta;
      const step = 1 / 60;
      while (this.accumulator >= step) {
        this.physicsStep(step);
        this.accumulator -= step;
      }
      this.pollGamepad();
      this.updateHUD(time);
    } else if (!this.inGame) {
      this.previewAngle += delta * .12;
      this.carGroup.rotation.y = this.previewAngle;
      this.camera.position.x = 2.8 + Math.sin(time * .00008) * 10.5;
      this.camera.position.z = Math.cos(time * .00008) * 10.5;
      this.camera.position.y = 4.7;
      this.camera.lookAt(2.8, .7, 0);
    }

    if (this.inGame) {
      this.animateVehicle(delta);
      this.updateCamera(delta);
      this.updateGuide();
      if (this.guideArrow) {
        this.guideArrow.position.y = 2.15 + Math.sin(time * .0035) * .18;
        this.guideArrow.rotation.y += delta * .55;
      }
      const pulse = .58 + Math.sin(time * .004) * .16;
      if (this.targetMaterial && this.assists && this.state.hold === 0) this.targetMaterial.emissiveIntensity = pulse;
    }

    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, innerWidth, innerHeight);
    this.renderer.render(this.scene, this.camera);
    if (this.isRearViewActive()) this.renderRearView();
    this.lastFrame = time;
  };

  private renderRearView() {
    const canvasRect = this.canvas.getBoundingClientRect();
    const monitorRect = this.ui.rearView.getBoundingClientRect();
    const inset = 4;
    const x = Math.round(monitorRect.left - canvasRect.left + inset);
    const y = Math.round(canvasRect.bottom - monitorRect.bottom + inset);
    const width = Math.round(monitorRect.width - inset * 2);
    const height = Math.round(monitorRect.height - inset * 2);
    if (width < 8 || height < 8) return;

    const forward = this.tmpVec.set(Math.sin(this.state.heading), 0, Math.cos(this.state.heading));
    const carPosition = this.tmpSide.set(this.state.x, 0, this.state.z);
    this.rearCamera.position.copy(carPosition).addScaledVector(forward, -this.currentCar.length * .46).add(new THREE.Vector3(0, 1.18, 0));
    this.rearCameraTarget.copy(carPosition).addScaledVector(forward, -8).add(new THREE.Vector3(0, .1, 0));
    this.rearCamera.lookAt(this.rearCameraTarget);
    this.rearCamera.aspect = width / height;
    this.rearCamera.updateProjectionMatrix();
    // A real rear-view mirror is horizontally reflected.
    this.rearCamera.projectionMatrix.elements[0] *= -1;
    this.rearCamera.projectionMatrixInverse.copy(this.rearCamera.projectionMatrix).invert();

    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, y, width, height);
    this.renderer.setScissor(x, y, width, height);
    this.renderer.render(this.scene, this.rearCamera);
    this.renderer.setScissorTest(false);
  }

  private physicsStep(dt: number) {
    const state = this.state;
    const car = this.currentCar;
    state.elapsed += dt;
    this.collisionCooldown = Math.max(0, this.collisionCooldown - dt);

    // Positive Y rotation turns the car toward screen-left in the chase view.
    // Keep the control names semantic across keyboard, touch, and gamepad.
    const steerInput = Number(this.controls.left) - Number(this.controls.right);
    const maxSteer = THREE.MathUtils.degToRad(car.maxSteer);
    const steerTarget = steerInput * maxSteer;
    const steerSpeed = steerInput === 0 ? 2.35 : 1.8;
    state.steer += clamp(steerTarget - state.steer, -steerSpeed * dt, steerSpeed * dt);

    const grip = this.currentLevel.rain ? .86 : 1;
    if (this.controls.throttle) {
      const direction = state.gear;
      const max = direction === 1 ? car.maxSpeed : car.maxReverse;
      const normalized = clamp(Math.abs(state.speed) / max, 0, 1);
      state.speed += direction * car.acceleration * (1 - normalized * .62) * grip * dt;
      state.speed = direction === 1 ? Math.min(state.speed, max) : Math.max(state.speed, -max);
    }
    if (this.controls.brake || this.controls.handbrake) {
      const strength = car.brake * (this.controls.handbrake ? 1.35 : 1) * dt;
      if (state.speed > 0) state.speed = Math.max(0, state.speed - strength);
      else if (state.speed < 0) state.speed = Math.min(0, state.speed + strength);
    }
    if (!this.controls.throttle) {
      const rolling = (this.currentLevel.rain ? .62 : .78) * dt;
      if (state.speed > 0) state.speed = Math.max(0, state.speed - rolling);
      else if (state.speed < 0) state.speed = Math.min(0, state.speed + rolling);
    }

    const oldX = state.x;
    const oldZ = state.z;
    const oldHeading = state.heading;
    if (Math.abs(state.speed) > .001) {
      state.heading += (state.speed / car.wheelbase) * Math.tan(state.steer) * dt;
      state.x += Math.sin(state.heading) * state.speed * dt;
      state.z += Math.cos(state.heading) * state.speed * dt;
    }

    const collision = this.checkCollision();
    if (collision) {
      const impact = Math.abs(state.speed);
      state.x = oldX;
      state.z = oldZ;
      state.heading = oldHeading;
      state.speed *= -.12;
      if (this.collisionCooldown <= 0 && impact > .18) {
        const heavy = impact > 3.1;
        const cost = heavy ? 180 : 80;
        state.penalty += cost;
        state.damage = Math.min(100, state.damage + (heavy ? 24 : 9));
        state.hits += 1;
        this.collisionCooldown = .5;
        this.sound.collision();
        if (navigator.vibrate) navigator.vibrate(heavy ? [45, 35, 55] : 35);
        this.showToast(`${heavy ? "Сильный удар" : "Касание"} · −${cost}`, true);
      }
    }

    if (state.damage >= 100) {
      this.finish(false, "Автомобиль повреждён");
      return;
    }
    if (state.elapsed >= this.currentLevel.timeLimit) {
      this.finish(false, "Время вышло");
      return;
    }
    this.evaluateParking(dt);
  }

  private getRectCorners(x: number, z: number, heading: number, width: number, length: number) {
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const hx = width / 2;
    const hz = length / 2;
    return [
      { x: x + rightX * hx + forwardX * hz, z: z + rightZ * hx + forwardZ * hz },
      { x: x - rightX * hx + forwardX * hz, z: z - rightZ * hx + forwardZ * hz },
      { x: x - rightX * hx - forwardX * hz, z: z - rightZ * hx - forwardZ * hz },
      { x: x + rightX * hx - forwardX * hz, z: z + rightZ * hx - forwardZ * hz },
    ];
  }

  private rectanglesOverlap(
    ax: number, az: number, ar: number, aw: number, al: number,
    bx: number, bz: number, br: number, bw: number, bl: number,
  ) {
    const aRight = { x: Math.cos(ar), z: -Math.sin(ar) };
    const aForward = { x: Math.sin(ar), z: Math.cos(ar) };
    const bRight = { x: Math.cos(br), z: -Math.sin(br) };
    const bForward = { x: Math.sin(br), z: Math.cos(br) };
    const center = { x: bx - ax, z: bz - az };
    const axes = [aRight, aForward, bRight, bForward];
    for (const axis of axes) {
      const distance = Math.abs(center.x * axis.x + center.z * axis.z);
      const radiusA = aw / 2 * Math.abs(aRight.x * axis.x + aRight.z * axis.z) + al / 2 * Math.abs(aForward.x * axis.x + aForward.z * axis.z);
      const radiusB = bw / 2 * Math.abs(bRight.x * axis.x + bRight.z * axis.z) + bl / 2 * Math.abs(bForward.x * axis.x + bForward.z * axis.z);
      if (distance >= radiusA + radiusB - .025) return false;
    }
    return true;
  }

  private checkCollision() {
    const state = this.state;
    const car = this.currentCar;
    const half = this.currentLevel.worldSize / 2 - .65;
    const corners = this.getRectCorners(state.x, state.z, state.heading, car.width * .93, car.length * .9);
    if (corners.some((corner) => Math.abs(corner.x) > half || Math.abs(corner.z) > half)) return true;
    return this.obstacles.some((obstacle) => this.rectanglesOverlap(
      state.x, state.z, state.heading, car.width * .92, car.length * .88,
      obstacle.x, obstacle.z, obstacle.rotation ?? 0, obstacle.width, obstacle.length,
    ));
  }

  private evaluateParking(dt: number) {
    const state = this.state;
    const zone = this.currentLevel.zone;
    const car = this.currentCar;
    const dx = state.x - zone.x;
    const dz = state.z - zone.z;
    const localX = dx * Math.cos(zone.rotation) - dz * Math.sin(zone.rotation);
    const localZ = dx * Math.sin(zone.rotation) + dz * Math.cos(zone.rotation);
    const centerDistance = Math.hypot(localX, localZ);
    const angle = parkingAngleDifference(state.heading, zone.rotation);
    const corners = this.getRectCorners(state.x, state.z, state.heading, car.width * .96, car.length * .93);
    const margin = .06;
    const inside = corners.every((corner) => {
      const cornerDx = corner.x - zone.x;
      const cornerDz = corner.z - zone.z;
      const x = cornerDx * Math.cos(zone.rotation) - cornerDz * Math.sin(zone.rotation);
      const z = cornerDx * Math.sin(zone.rotation) + cornerDz * Math.cos(zone.rotation);
      return Math.abs(x) <= zone.width / 2 - margin && Math.abs(z) <= zone.length / 2 - margin;
    });
    const positionScore = clamp(1 - centerDistance / Math.max(zone.width, zone.length), 0, 1);
    const angleScore = clamp(1 - angle / THREE.MathUtils.degToRad(35), 0, 1);
    state.accuracy = Math.round((positionScore * .62 + angleScore * .38) * 100);

    if (centerDistance < 9) this.ui.accuracy.textContent = `${state.accuracy}%`;
    else this.ui.accuracy.textContent = "—";

    const valid = inside && angle < THREE.MathUtils.degToRad(14) && Math.abs(state.speed) < .16;
    if (valid) {
      state.hold += dt;
      const progress = clamp(state.hold / 1.5, 0, 1);
      if (this.targetMaterial) {
        this.targetMaterial.color.set(0xb9f34a);
        this.targetMaterial.emissive.set(0xb9f34a);
        this.targetMaterial.opacity = .24 + progress * .25;
        this.targetMaterial.emissiveIntensity = .8 + progress * 1.2;
      }
      if (progress > .08) this.ui.objectiveHint.textContent = `Удерживайте позицию… ${Math.round(progress * 100)}%`;
      if (state.hold >= 1.5) this.finish(true);
    } else {
      state.hold = Math.max(0, state.hold - dt * 2.3);
      if (this.targetMaterial) {
        this.targetMaterial.color.set(inside ? 0xffb547 : 0xb9f34a);
        this.targetMaterial.emissive.set(inside ? 0xffb547 : 0xb9f34a);
      }
      if (this.assists && centerDistance < 9) {
        if (Math.abs(state.speed) > 2.2) this.ui.objectiveHint.textContent = "Снизьте скорость перед манёвром.";
        else if (!inside && centerDistance > 1.3) this.ui.objectiveHint.textContent = "Совместите центр машины с парковочным местом.";
        else if (angle > THREE.MathUtils.degToRad(14)) this.ui.objectiveHint.textContent = "Выровняйте автомобиль по линиям.";
        else if (inside) this.ui.objectiveHint.textContent = "Полностью остановитесь внутри контура.";
      }
    }
  }

  private finish(success: boolean, reason = "") {
    if (this.state.finished) return;
    this.state.finished = true;
    this.resultSuccess = success;
    this.releaseControls();
    this.ui.rotateNotice.classList.remove("visible");
    this.updateViewPresentation();
    this.sound.updateEngine(0, false);

    const angle = parkingAngleDifference(this.state.heading, this.currentLevel.zone.rotation);
    const timePenalty = Math.max(0, this.state.elapsed - this.currentLevel.parTime) * 3;
    const alignmentPenalty = THREE.MathUtils.radToDeg(angle) * 4;
    const score = success ? Math.round(clamp(1000 - this.state.penalty - timePenalty - alignmentPenalty + (this.assists ? 0 : 100), 100, 1100)) : 0;
    const stars = score >= 850 && this.state.hits < 2 ? 3 : score >= 650 ? 2 : success ? 1 : 0;
    const key = `${this.currentLevel.id}:${this.currentCar.id}:${this.assists ? "assist" : "expert"}`;
    const previous = this.save.best[key] ?? 0;
    const isBest = success && score > previous;
    if (isBest) this.save.best[key] = score;
    this.persist();

    this.ui.resultEyebrow.textContent = success ? "ПАРКОВКА ЗАВЕРШЕНА" : "ПОПЫТКА ЗАВЕРШЕНА";
    this.ui.resultTitle.textContent = success ? (stars === 3 ? "Чистая работа." : "Место занято.") : reason || "Попробуем ещё раз.";
    this.ui.resultStars.innerHTML = [1, 2, 3].map((star) => `<span class="${star <= stars ? "" : "off"}">★</span>`).join(" ");
    this.ui.resultStars.setAttribute("aria-label", `Результат: ${stars} из 3 звёзд`);
    this.ui.resultScore.textContent = score.toString();
    this.ui.resultAccuracy.textContent = success ? `${this.state.accuracy}%` : "—";
    this.ui.resultTime.textContent = formatTime(this.state.elapsed, true);
    this.ui.resultHits.textContent = this.state.hits.toString();
    this.ui.bestBadge.textContent = isBest ? "НОВЫЙ ЛИЧНЫЙ РЕКОРД" : previous ? `ЛУЧШИЙ СЧЁТ · ${previous}` : "СЛЕДУЮЩАЯ ПОПЫТКА БУДЕТ ТОЧНЕЕ";
    this.ui.nextButton.querySelector("span")!.textContent = success ? "Следующий сценарий" : "Повторить заезд";
    this.ui.result.classList.add("open");
    if (success) this.sound.success();
  }

  private nearestObstacleDistance() {
    let nearest = Infinity;
    const carRadius = Math.hypot(this.currentCar.width, this.currentCar.length) * .35;
    for (const obstacle of this.obstacles) {
      const obstacleRadius = Math.hypot(obstacle.width, obstacle.length) * .36;
      nearest = Math.min(nearest, Math.hypot(this.state.x - obstacle.x, this.state.z - obstacle.z) - carRadius - obstacleRadius);
    }
    const half = this.currentLevel.worldSize / 2;
    nearest = Math.min(nearest, half - Math.abs(this.state.x) - this.currentCar.width / 2, half - Math.abs(this.state.z) - this.currentCar.length / 2);
    return Math.max(0, nearest);
  }

  private updateHUD(now: number) {
    const state = this.state;
    this.ui.timer.textContent = formatTime(state.elapsed);
    this.ui.penalty.textContent = state.penalty.toString();
    this.ui.speed.textContent = Math.round(Math.abs(state.speed) * 3.6).toString();
    this.ui.steering.style.left = `${50 - (state.steer / THREE.MathUtils.degToRad(this.currentCar.maxSteer)) * 48}%`;
    const distance = this.nearestObstacleDistance();
    const sensorVisible = distance < 4.2;
    this.ui.sensor.classList.toggle("visible", sensorVisible);
    this.ui.sensor.classList.toggle("warning", distance < 2.1 && distance >= .85);
    this.ui.sensor.classList.toggle("danger", distance < .85);
    this.ui.sensorText.textContent = distance < .45 ? "Стоп!" : distance < 1 ? `${distance.toFixed(1)} м · очень близко` : distance < 4.2 ? `${distance.toFixed(1)} м` : "Свободно";
    if (this.assists || distance < 1.25) this.sound.sensor(distance, now);
    this.sound.updateEngine(state.speed, true);
  }

  private animateVehicle(delta: number) {
    this.carGroup.position.set(this.state.x, 0, this.state.z);
    this.carGroup.rotation.y = this.state.heading;
    const rotation = this.state.speed * delta / .34;
    for (const wheel of this.carWheels) wheel.rotation.x += rotation;
    for (const wheel of this.frontWheels) wheel.rotation.y = this.state.steer;
    const braking = this.controls.brake || this.controls.handbrake;
    for (const material of this.brakeLights) material.emissiveIntensity = braking ? 4 : .7;
  }

  private updateCamera(delta: number) {
    const heading = this.state.heading;
    const forward = this.tmpVec.set(Math.sin(heading), 0, Math.cos(heading));
    const carPosition = new THREE.Vector3(this.state.x, 0, this.state.z);
    const desiredPosition = new THREE.Vector3();
    const desiredTarget = new THREE.Vector3();
    if (this.cameraMode === 0) {
      desiredPosition.copy(carPosition).addScaledVector(forward, -7.8).add(new THREE.Vector3(0, 4.35, 0));
      desiredTarget.copy(carPosition).addScaledVector(forward, 2).add(new THREE.Vector3(0, .75, 0));
    } else if (this.cameraMode === 1) {
      desiredPosition.copy(carPosition).add(new THREE.Vector3(0, 15.5, .01));
      desiredTarget.copy(carPosition).addScaledVector(forward, .6);
    } else if (this.cameraMode === 2) {
      desiredPosition.copy(carPosition).addScaledVector(forward, this.currentCar.length * .32).add(new THREE.Vector3(0, 1.35, 0));
      desiredTarget.copy(carPosition).addScaledVector(forward, 11).add(new THREE.Vector3(0, 1, 0));
    } else {
      const side = this.tmpSide.set(Math.cos(heading), 0, -Math.sin(heading));
      const eyeHeight = THREE.MathUtils.clamp(this.currentCar.height * .8, 1.08, 1.32);
      const driverOffset = this.currentCar.width * .18;
      desiredPosition.copy(carPosition).addScaledVector(forward, this.currentCar.length * .11).addScaledVector(side, driverOffset).add(new THREE.Vector3(0, eyeHeight, 0));
      desiredTarget.copy(carPosition).addScaledVector(forward, 11).addScaledVector(side, driverOffset).add(new THREE.Vector3(0, eyeHeight - .32, 0));
    }
    const smoothing = 1 - Math.exp(-delta * (this.cameraMode >= 2 ? 14 : 5.5));
    this.cameraPosition.lerp(desiredPosition, smoothing);
    this.cameraTarget.lerp(desiredTarget, smoothing);
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.cameraTarget);
    const portraitCockpit = this.cameraMode === 3 && innerHeight > innerWidth;
    const desiredFov = this.cameraMode === 3 ? (portraitCockpit ? 72 : 59) : 46;
    const nextFov = THREE.MathUtils.lerp(this.camera.fov, desiredFov, 1 - Math.exp(-delta * 9));
    if (Math.abs(nextFov - this.camera.fov) > .01) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
    this.updateGarageRoofVisibility();
  }

  private pollGamepad() {
    const gamepad = navigator.getGamepads?.()[0];
    if (!gamepad) return;
    const axis = gamepad.axes[0] || 0;
    if (Math.abs(axis) > .18) {
      this.controls.left = axis < -.18;
      this.controls.right = axis > .18;
    }
    this.controls.throttle = (gamepad.buttons[7]?.value ?? 0) > .15;
    this.controls.brake = (gamepad.buttons[6]?.value ?? 0) > .15;
  }

  private resize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 800 ? 1.6 : 2));
    this.renderer.setSize(innerWidth, innerHeight);
  };
}

new ParkingGame();
