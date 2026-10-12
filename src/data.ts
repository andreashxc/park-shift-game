export type CarId = "hatch" | "sedan" | "suv";

export interface CarConfig {
  id: CarId;
  name: string;
  className: string;
  color: number;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  maxSpeed: number;
  maxReverse: number;
  acceleration: number;
  brake: number;
  maxSteer: number;
  handling: number;
  sizeRating: number;
  difficulty: number;
}

export type ObstacleKind = "car" | "wall" | "pillar" | "planter" | "barrier";

export interface ObstacleConfig {
  x: number;
  z: number;
  width: number;
  length: number;
  height?: number;
  rotation?: number;
  kind: ObstacleKind;
  color?: number;
}

export interface ParkingZone {
  x: number;
  z: number;
  width: number;
  length: number;
  rotation: number;
}

export interface LevelConfig {
  id: string;
  name: string;
  shortName: string;
  description: string;
  objective: string;
  hint: string;
  difficulty: "Легко" | "Средне" | "Сложно" | "Экзамен";
  conditionLabel: string;
  spawn: { x: number; z: number; heading: number };
  zone: ParkingZone;
  obstacles: ObstacleConfig[];
  parTime: number;
  timeLimit: number;
  worldSize: number;
  night?: boolean;
  rain?: boolean;
  garage?: boolean;
}

export const CARS: CarConfig[] = [
  {
    id: "hatch",
    name: "Metro Mini",
    className: "ХЭТЧБЕК",
    color: 0xb9f34a,
    length: 4,
    width: 1.74,
    height: 1.48,
    wheelbase: 2.45,
    maxSpeed: 9,
    maxReverse: 4.2,
    acceleration: 4.4,
    brake: 8.2,
    maxSteer: 35,
    handling: 5,
    sizeRating: 2,
    difficulty: 1,
  },
  {
    id: "sedan",
    name: "Aero S",
    className: "СЕДАН",
    color: 0x55d8e7,
    length: 4.72,
    width: 1.84,
    height: 1.42,
    wheelbase: 2.76,
    maxSpeed: 10,
    maxReverse: 4,
    acceleration: 3.9,
    brake: 7.7,
    maxSteer: 32,
    handling: 4,
    sizeRating: 3,
    difficulty: 2,
  },
  {
    id: "suv",
    name: "Atlas X",
    className: "КРОССОВЕР",
    color: 0xffb547,
    length: 4.95,
    width: 1.96,
    height: 1.78,
    wheelbase: 2.86,
    maxSpeed: 8.2,
    maxReverse: 3.5,
    acceleration: 3.45,
    brake: 7.1,
    maxSteer: 29,
    handling: 3,
    sizeRating: 5,
    difficulty: 4,
  },
];

const parkedCar = (x: number, z: number, rotation = 0, color?: number): ObstacleConfig => ({
  x,
  z,
  width: 1.9,
  length: 4.7,
  height: 1.55,
  rotation,
  kind: "car",
  color,
});

const pillar = (x: number, z: number): ObstacleConfig => ({
  x,
  z,
  width: 0.8,
  length: 0.8,
  height: 3.4,
  kind: "pillar",
});

export const LEVELS: LevelConfig[] = [
  {
    id: "training",
    name: "Базовая разметка",
    shortName: "Учебная площадка",
    description: "Прямая парковка на открытой площадке",
    objective: "Займите выделенное место",
    hint: "Подъезжайте по центру, выровняйте руль и полностью остановитесь.",
    difficulty: "Легко",
    conditionLabel: "ДЕНЬ · СУХО",
    spawn: { x: -7, z: -10, heading: 0 },
    zone: { x: 6, z: 7, width: 3.2, length: 6.3, rotation: 0 },
    obstacles: [parkedCar(-7, 7, 0, 0x8b95a2), parkedCar(-3.5, 7, 0, 0x49566f), parkedCar(10, 7, 0, 0xb15d4e)],
    parTime: 38,
    timeLimit: 120,
    worldSize: 32,
  },
  {
    id: "between-cars",
    name: "Точный слот",
    shortName: "Между машинами",
    description: "Узкое место требует аккуратного захода",
    objective: "Встаньте между автомобилями",
    hint: "Возьмите шире перед поворотом и следите за боковыми датчиками.",
    difficulty: "Средне",
    conditionLabel: "ДЕНЬ · ПЛОТНО",
    spawn: { x: -10, z: -8, heading: 0.18 },
    zone: { x: 2, z: 8, width: 2.85, length: 5.8, rotation: 0 },
    obstacles: [parkedCar(-1.2, 8, 0, 0x52606d), parkedCar(5.2, 8, 0, 0xd4d8d9), parkedCar(9, 8, 0, 0x8f4b42), parkedCar(-7, 8, 0, 0x35495b)],
    parTime: 48,
    timeLimit: 125,
    worldSize: 34,
  },
  {
    id: "reverse-bay",
    name: "Задний ход",
    shortName: "Узкий бокс",
    description: "Заезд кормой между ограничителями",
    objective: "Припаркуйтесь задним ходом",
    hint: "Проедьте чуть дальше места, включите R и смотрите в верхнюю камеру.",
    difficulty: "Средне",
    conditionLabel: "ЗАКАТ · БАРЬЕРЫ",
    spawn: { x: -7, z: -7, heading: 0 },
    zone: { x: 7, z: 8, width: 3, length: 5.9, rotation: Math.PI },
    obstacles: [
      parkedCar(3.7, 8, 0, 0x9a3c43), parkedCar(10.3, 8, 0, 0x35485e),
      { x: 2, z: 12, width: 20, length: .45, height: .55, kind: "barrier" },
      { x: 5.25, z: 5.3, width: .25, length: .25, height: .3, kind: "barrier" },
      { x: 8.75, z: 5.3, width: .25, length: .25, height: .3, kind: "barrier" },
    ],
    parTime: 58,
    timeLimit: 135,
    worldSize: 34,
  },
  {
    id: "parallel",
    name: "У бордюра",
    shortName: "Параллельная",
    description: "Классическая городская парковка",
    objective: "Встаньте параллельно бордюру",
    hint: "Сравняйте заднюю ось с соседней машиной, затем плавно сдавайте назад.",
    difficulty: "Сложно",
    conditionLabel: "ГОРОД · ВЕЧЕР",
    spawn: { x: -10, z: -7, heading: Math.PI / 2 },
    zone: { x: 4, z: 7.5, width: 2.9, length: 6.6, rotation: Math.PI / 2 },
    obstacles: [
      parkedCar(-1.9, 7.5, Math.PI / 2, 0xd8dad4), parkedCar(10, 7.5, Math.PI / 2, 0x566877),
      { x: 0, z: 10.4, width: 30, length: .55, height: .3, kind: "wall" },
      { x: -10, z: 11.8, width: 3.5, length: 2.2, height: .7, kind: "planter" },
    ],
    parTime: 72,
    timeLimit: 150,
    worldSize: 36,
  },
  {
    id: "garage",
    name: "Уровень −2",
    shortName: "Тесный паркинг",
    description: "Колонны, бетон и минимум пространства",
    objective: "Найдите место между колоннами",
    hint: "Двигайтесь медленно: колонны находятся в слепых зонах.",
    difficulty: "Сложно",
    conditionLabel: "ПАРКИНГ · СУМРАК",
    spawn: { x: -10, z: -9, heading: .1 },
    zone: { x: 6, z: 8, width: 3, length: 5.9, rotation: 0 },
    obstacles: [
      pillar(-9, -1), pillar(-3, -1), pillar(3, -1), pillar(9, -1),
      pillar(-9, 12), pillar(-3, 12), pillar(3, 12), pillar(9, 12),
      parkedCar(-6, 8, 0, 0x304659), parkedCar(-2, 8, 0, 0xa7acaa), parkedCar(10, 8, 0, 0x485c49),
      { x: 0, z: 14.5, width: 31, length: .7, height: 2, kind: "wall" },
    ],
    parTime: 78,
    timeLimit: 165,
    worldSize: 34,
    garage: true,
  },
  {
    id: "night-rain",
    name: "После дождя",
    shortName: "Ночная смена",
    description: "Мокрый асфальт и плохая видимость",
    objective: "Пройдите ночной экзамен",
    hint: "Тормозной путь увеличен. Ориентируйтесь по разметке и фарам.",
    difficulty: "Экзамен",
    conditionLabel: "НОЧЬ · ДОЖДЬ",
    spawn: { x: -9, z: -10, heading: 0 },
    zone: { x: 7.2, z: 8, width: 2.95, length: 5.9, rotation: 0 },
    obstacles: [
      parkedCar(-8.5, 8, 0, 0x5a323b), parkedCar(-5, 8, 0, 0x384b58), parkedCar(3.8, 8, 0, 0x9c9f96), parkedCar(10.5, 8, 0, 0x3d4c35),
      { x: -12, z: 1, width: 3, length: 3, height: .8, kind: "planter" },
      { x: 12, z: -1, width: 3, length: 3, height: .8, kind: "planter" },
    ],
    parTime: 88,
    timeLimit: 175,
    worldSize: 36,
    night: true,
    rain: true,
  },
];
