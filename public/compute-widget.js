// Adapted from block/buzz mesh-buddy-window and the four-design native-integration study (Apache-2.0).

const font = {
  " ": "000000000000000",
  0: "111101101101111",
  1: "010110010010111",
  2: "111001111100111",
  3: "111001111001111",
  4: "101101111001001",
  5: "111100111001111",
  6: "111100111101111",
  7: "111001010010010",
  8: "111101111101111",
  9: "111101111001111",
  A: "010101111101101",
  B: "110101110101110",
  C: "111100100100111",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "111100101101111",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101111",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "110101101101101",
  O: "111101101101111",
  P: "111101111100100",
  Q: "111101101111001",
  R: "110101110101101",
  S: "111100111001111",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101101111111",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  "/": "001001010100100",
  "-": "000000111000000",
  "+": "000010111010000",
};

const phases = [
  { id: "sleep", label: "Sleep", word: "SLEEP", duration: 2000 },
  { id: "link", label: "Connecting", word: "WAKING", duration: 2000 },
  { id: "warm", label: "Warming", word: "WARMING", duration: 2000 },
  { id: "active", label: "Generating", word: "WORKING", duration: 5000 },
  { id: "complete", label: "Complete", word: "SERVED", duration: 2000 },
  { id: "error", label: "Error", word: "ERROR", duration: 2500 },
  { id: "offline", label: "Disconnected", word: "OFFLINE", duration: 2000 },
  { id: "recovery", label: "Recovery", word: "WAKING", duration: 2500 },
  { id: "online", label: "Recovered", word: "READY", duration: 2000 },
  { id: "rest", label: "Sleep again", word: "SLEEP", duration: 2000 },
];

const northPose = [
  [0, -3],
  [0, -2],
  [0, 0],
  [-4, 0],
  [6, 0],
  [-4, -1],
  [4, -1],
  [-4, 2],
  [4, 2],
  [-4, 1],
  [6, 1],
  [0, 2],
  [0, 4],
  [0, -1],
  [1, -4],
  [1, -2],
  [1, 0],
  [1, 2],
  [1, 4],
  [2, -2],
  [2, -1],
  [2, 0],
  [2, 1],
  [2, 2],
  [2, 3],
  [-1, -4],
  [-1, -2],
  [-1, 0],
  [-5, 0],
  [5, 0],
  [-5, -1],
  [5, -1],
  [-5, 2],
  [-5, 1],
  [5, 1],
  [5, 2],
  [-1, 2],
  [-1, 4],
  [-2, -2],
  [-2, -1],
  [-2, 0],
  [-6, 0],
  [4, 0],
  [-6, 1],
  [4, 1],
  [-2, 1],
  [-2, 2],
  [-2, 3],
];
const northeastPose = [
  [2.1212999999999993, -2.1212999999999993],
  [1.4141999999999997, -1.4141999999999997],
  [0, 0],
  [-2.8284499999999992, -2.8284499999999992],
  [4.24265, 4.24265],
  [-2.1212999999999993, -3.5355500000000006],
  [3.5355500000000006, 2.1212999999999993],
  [-4.24265, -1.4141999999999997],
  [1.4141999999999997, 4.24265],
  [-3.5355500000000006, -2.1212999999999993],
  [3.5355500000000006, 4.94975],
  [-1.4141999999999997, 1.4141999999999997],
  [-2.8284499999999992, 2.828450000000001],
  [0.7070999999999998, -0.7070999999999998],
  [3.5355500000000006, -2.1212999999999993],
  [2.1212999999999993, -0.7070999999999998],
  [0.7070999999999998, 0.7070999999999998],
  [-0.7070999999999998, 2.1212999999999993],
  [-2.1212999999999993, 3.5355500000000006],
  [2.8283999999999994, 0],
  [2.1212999999999993, 0.7070999999999998],
  [1.4141999999999997, 1.4141999999999997],
  [0.7070999999999998, 2.1212999999999993],
  [0, 2.828450000000001],
  [-0.7070999999999998, 3.5355500000000006],
  [2.1212999999999993, -3.5355500000000006],
  [0.7070999999999998, -2.1212999999999993],
  [-0.7070999999999998, -0.7070999999999998],
  [-3.5355500000000006, -3.5355500000000006],
  [3.5355500000000006, 3.5355500000000006],
  [-2.8284499999999992, -4.24265],
  [4.24265, 2.828450000000001],
  [-4.94975, -2.1212999999999993],
  [-4.24265, -2.8284499999999992],
  [2.8283999999999994, 4.24265],
  [2.1212999999999993, 4.94975],
  [-2.1212999999999993, 0.7070999999999998],
  [-3.5355500000000006, 2.1212999999999993],
  [0, -2.8284499999999992],
  [-0.7070999999999998, -2.1212999999999993],
  [-1.4141999999999997, -1.4141999999999997],
  [-4.24265, -4.24265],
  [2.8283999999999994, 2.828450000000001],
  [-4.94975, -3.5355500000000006],
  [2.1212999999999993, 3.5355500000000006],
  [-2.1212999999999993, -0.7070999999999998],
  [-2.8284499999999992, 0],
  [-3.5355500000000006, 0.7070999999999998],
];
function beePose(heading, plot, wingFold = 0) {
  const source = heading % 2 ? northeastPose : northPose;
  const turns = Math.floor(heading / 2);
  for (const [pointIndex, point] of source.entries()) {
    if (wingFold > 0 && Math.abs(northPose[pointIndex][0]) >= 7 - wingFold)
      continue;
    let [horizontal, vertical] = point;
    for (let index = 0; index < turns; index += 1) {
      const prior = horizontal;
      horizontal = -vertical;
      vertical = prior;
    }
    plot(horizontal, vertical, 217 / 255);
  }
}

function buffer() {
  return {
    white: new Float32Array(4096),
    red: new Float32Array(4096),
    sprite: [],
    streaks: [],
  };
}
function dot(frame, horizontal, vertical, brightness = 1, color = "white") {
  const column = Math.round(horizontal),
    row = Math.round(vertical);
  if (column < 0 || column > 63 || row < 0 || row > 63) return;
  const address = row * 64 + column;
  frame[color][address] = Math.max(frame[color][address], brightness);
}
function label(
  frame,
  value,
  vertical,
  scale = 1,
  brightness = 0.9,
  color = "white",
  align = "center",
) {
  value = String(value);
  let left =
    align === "left"
      ? 4
      : align === "right"
        ? 60 - (value.length * 4 - 1) * scale
        : Math.round((64 - (value.length * 4 - 1) * scale) / 2);
  for (const character of value) {
    const glyph = font[character] || font[" "];
    for (let row = 0; row < 5; row += 1)
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row * 3 + column] !== "1") continue;
        for (let offsetY = 0; offsetY < scale; offsetY += 1)
          for (let offsetX = 0; offsetX < scale; offsetX += 1)
            dot(
              frame,
              left + column * scale + offsetX,
              vertical + row * scale + offsetY,
              brightness,
              color,
            );
      }
    left += 4 * scale;
  }
}
function arc(
  frame,
  centerY,
  radius,
  start,
  end,
  brightness = 0.4,
  color = "white",
) {
  if (radius === 23 && color === "white") {
    const fullTurn = Math.PI * 2;
    const span = end - start;
    for (let index = 0; index < 96; index++) {
      const angle = (index * fullTurn) / 96;
      const relative = (((angle - start) % fullTurn) + fullTurn) % fullTurn;
      if (span <= 0 || (span < fullTurn && relative >= span)) continue;
      const horizontal = 32 + Math.sin(angle) * 20,
        vertical = centerY - Math.cos(angle) * 20;
      const existing = frame.sprite.find(
        (dot) => dot[0] === horizontal && dot[1] === vertical && dot[3] === 2.9,
      );
      if (existing) existing[2] = Math.max(existing[2], brightness);
      else frame.sprite.push([horizontal, vertical, brightness, 2.9]);
    }
    return;
  }
  for (let angle = start; angle < end; angle += 0.055)
    dot(
      frame,
      31.5 + Math.sin(angle) * radius,
      centerY - Math.cos(angle) * radius,
      brightness,
      color,
    );
}
function bee(
  frame,
  elapsed,
  reduced,
  sleeping = false,
  awake = sleeping ? 0 : 1,
) {
  const motion = reduced ? 0 : elapsed;
  const lift = (1 - awake) * Math.sin(motion / 600) * 0.6;
  const retainedHeading =
    returnHeading !== null &&
    ["complete", "online", "rest"].includes(model.phase);
  const angle = retainedHeading
    ? model.phase === "rest"
      ? awake * returnHeading + ((1 - awake) * Math.PI) / 4
      : returnHeading
    : ((1 - awake) * Math.PI) / 4;
  const returnProgress = reduced ? 1 : Math.min(1, Math.max(0, elapsed / 700));
  const returnEase = returnProgress * returnProgress * (3 - 2 * returnProgress);
  const returning = model.phase === "complete" && returnScale !== null;
  const size = returning ? returnScale + (1 - returnScale) * returnEase : 1;
  const face = [
    [-2, -2],
    [0, -2],
    [2, -2],
    [-2, -1],
    [-1, -1],
    [1, -1],
    [2, -1],
    [-2, 0],
    [0, 0],
    [2, 0],
  ];
  const pose = sleeping
    ? northPose
        .filter(
          ([horizontal, vertical]) =>
            !(Math.abs(horizontal) <= 2 && vertical >= -2 && vertical <= 0),
        )
        .concat(face)
    : northPose;
  for (const [horizontal, vertical] of pose) {
    const rotatedX = horizontal * Math.cos(angle) - vertical * Math.sin(angle);
    const rotatedY = horizontal * Math.sin(angle) + vertical * Math.cos(angle);
    frame.sprite.push([
      32 + rotatedX * 2 * size,
      32 + rotatedY * 2 * size + lift,
      0.58 + 0.27 * awake,
      5.6 * size,
    ]);
  }
  if (sleeping) {
    for (let index = 0; index < 3; index += 1) {
      const age = reduced
        ? 0.2 + index * 0.27
        : ((motion + [0, 1530, 3070][index]) % 4600) / 4600;
      const horizontal =
        36 + age * 8 + (reduced ? 0 : Math.sin(age * 3 + index) * 0.35);
      const vertical = 25 - age * 12;
      const ink =
        Math.sin(Math.PI * age) ** 6 * 0.65 +
        0.14 * Math.sin(Math.PI * Math.min(1, age / 0.4)) ** 2;
      const glyph = font.Z;
      for (let row = 0; row < 5; row += 1)
        for (let column = 0; column < 3; column += 1)
          if (glyph[row * 3 + column] === "1")
            dot(frame, horizontal + column, vertical + row, ink);
    }
  }
}
function draw(_design, current, reduced) {
  const { phase, index, elapsed } = current;
  const frame = buffer();
  const data = metrics(index, elapsed);
  const motion = reduced
    ? 900
    : phase.id === "active"
      ? Math.max(0, elapsed - 700) * 0.78
      : elapsed;
  const active = phase.id === "active";
  const linking = ["link", "recovery"].includes(phase.id);
  const failed = phase.id === "error";
  const offline = phase.id === "offline";
  const completed = phase.id === "complete";
  const resting = ["sleep", "rest"].includes(phase.id);
  const warming = phase.id === "warm";
  let statusWord = phase.word;
  if (active) {
    const breath = reduced ? 0.18 : 0.18 + Math.sin(motion / 1400) * 0.04;
    if (!linking && !completed)
      arc(frame, 32, 23, 0, Math.PI * 2, failed ? 0.14 : breath);
    if (linking)
      arc(
        frame,
        32,
        23,
        0,
        (reduced ? 1 : Math.max(0, Math.min(1, (elapsed - 650) / 1200))) *
          Math.PI *
          2,
        0.65,
      );
    if (completed)
      arc(
        frame,
        32,
        23,
        0,
        (reduced ? 0 : Math.max(0, 1 - elapsed / 1200)) * Math.PI * 2,
        0.6,
      );
    if (failed) arc(frame, 32, 23, -0.13, 0.13, 0.65, "red");
  }
  if (resting || linking || completed || phase.id === "online") {
    const settling = phase.id === "rest";
    const awake = linking
      ? reduced
        ? 1
        : Math.min(1, elapsed / 650)
      : completed
        ? reduced
          ? 0
          : Math.max(0, 1 - (elapsed - 1200) / 650)
        : settling
          ? reduced
            ? 0
            : Math.max(0, 1 - elapsed / 750)
          : resting
            ? 0
            : 1;
    bee(frame, elapsed, reduced, resting && awake === 0, Math.min(1, awake));
    if (resting && awake > 0) statusWord = "RESTING";
  } else if (warming) {
    const fill = reduced ? 0.8 : Math.min(1, elapsed / 1800);
    for (let row = 0; row < 64; row += 1)
      for (let column = 0; column < 64; column += 1) {
        const front = 64 - fill * 80;
        const gradient = Math.max(0, Math.min(1, (row - front) / 24));
        const softness = 0.8 + 0.2 * Math.cos((column - 31.5) / 32);
        dot(frame, column, row, gradient * softness * 0.2);
      }
  } else if (active) {
    const headings = [0, 1, 2, 3, 4, 5, 6, 7];
    let directionSeed =
      (Math.floor(model.changed * 1000) +
        Math.floor(motion / (2800 * 8)) * 2654435761) >>>
      0;
    for (let slot = 7; slot > 1; slot--) {
      directionSeed = (Math.imul(directionSeed, 1664525) + 1013904223) >>> 0;
      const target = 1 + (directionSeed % slot);
      [headings[slot], headings[target]] = [headings[target], headings[slot]];
    }
    const visit = reduced ? 0 : Math.floor(motion / 2800) % headings.length;
    const age = reduced ? 1900 : motion % 2800;
    const centerX = 32;
    const entry = reduced ? 1 : Math.min(1, Math.max(0, elapsed / 700));
    const entryEase = entry * entry * (3 - 2 * entry);
    const centerY = 32;
    const direction =
      entry < 1
        ? 0
        : headings[
            (visit + (!reduced && age >= 2150 ? 1 : 0)) % headings.length
          ];
    lastFlightHeading = (direction * Math.PI) / 4;
    const heading = (direction * Math.PI) / 4;
    const turnProgress = reduced
      ? 0
      : Math.max(0, Math.min(1, (age - 1750) / 400));
    const turnEase = turnProgress * turnProgress * (3 - 2 * turnProgress);
    const nextDirection = headings[(visit + 1) % headings.length];
    const turnDistance = ((nextDirection - headings[visit] + 12) % 8) - 4;
    const indicatorHeading =
      ((headings[visit] + turnDistance * turnEase) * Math.PI) / 4;
    arc(frame, 32, 23, indicatorHeading - 0.09, indicatorHeading + 0.1, 0.8);
    const flowerApproachAge =
      age >= 2350 ? age - 2350 : age + (motion >= 2800 ? 450 : 0);
    const flowerApproachDuration = motion < 2800 && age < 2350 ? 1600 : 2050;
    const flowerProgress = Math.min(
      1,
      flowerApproachAge / flowerApproachDuration,
    );
    const flowerTravel = 1 - (1 - flowerProgress) ** 2;
    const flowerDistance = 15 * (1 - flowerTravel);
    const flowerX = centerX + Math.sin(heading) * flowerDistance;
    const flowerY = centerY - Math.cos(heading) * flowerDistance;
    const flowerFadeProgress = Math.min(1, flowerApproachAge / 240);
    const flowerFade = reduced
      ? 1
      : flowerFadeProgress * flowerFadeProgress * (3 - 2 * flowerFadeProgress);
    const covered = Math.max(0, Math.min(1, (flowerTravel - 0.75) / 0.25));
    const flowerInk =
      (reduced ? 0.35 : 0.55) * flowerFade * (1 - covered * 0.92) * entryEase;
    const flowerCircles = [
      [27, 27],
      [27, 75],
      [75, 27],
      [41, 41],
      [27, 7],
      [27, 55],
      [75, 55],
      [7, 27],
      [55, 27],
      [55, 75],
      [7, 55],
      [55, 7],
      [55, 55],
    ];
    const backgroundVisit = Math.floor(motion / 2800) + (age >= 2350 ? 1 : 0);
    const backgroundAge =
      age >= 2350 ? age - 2350 : age + (motion >= 2800 ? 450 : 0);
    const backgroundFade = Math.min(1, backgroundAge / 400);
    const landingFade =
      age >= 2350 ? 1 : Math.max(0, Math.min(1, (1750 - age) / 350));
    const depthInk = reduced
      ? 0
      : 0.25 *
        backgroundFade *
        backgroundFade *
        (3 - 2 * backgroundFade) *
        landingFade *
        landingFade *
        (3 - 2 * landingFade) *
        entryEase;
    const backgroundDistance =
      ((Math.min(backgroundAge, 1600) +
        Math.max(0, backgroundAge - 1600) * 0.5) *
        15) /
      3200;
    const placementShift = Math.sin(backgroundVisit * 2.4) * 3;
    for (const [seedX, seedY] of [
      [-13 + placementShift, -8],
      [8, 12 - placementShift],
    ]) {
      const backgroundX = seedX - Math.sin(heading) * backgroundDistance;
      const backgroundY = seedY + Math.cos(heading) * backgroundDistance;
      for (let stripeDot = 0; stripeDot < 9; stripeDot++) {
        const stripeOffset = (stripeDot - 4) * 0.31;
        const offsetX = backgroundX + Math.sin(heading) * stripeOffset,
          offsetY = backgroundY - Math.cos(heading) * stripeOffset;
        if (Math.hypot(offsetX, offsetY) < 21)
          frame.sprite.push([
            centerX + offsetX,
            centerY + offsetY,
            depthInk,
            1.4,
          ]);
      }
    }
    for (const [horizontal, vertical] of flowerCircles)
      frame.sprite.push([
        flowerX + (horizontal - 41) / 20,
        flowerY + (vertical - 41) / 20,
        (flowerInk * 217) / 255,
        2.8,
      ]);
    const departureAge =
      age >= 2350 ? age - 2350 : motion >= 2800 ? age + 450 : -1;
    if (!reduced && departureAge >= 0 && departureAge < 1600) {
      const departure = departureAge / 1600;
      const distance = 15 * departure;
      const ink =
        0.55 *
        Math.min(1, 0.08 + departureAge / 200) *
        Math.max(0, Math.min(1, (750 - departureAge) / 300));
      for (const [horizontal, vertical] of flowerCircles)
        frame.sprite.push([
          centerX - Math.sin(heading) * distance + (horizontal - 41) / 20,
          centerY + Math.cos(heading) * distance + (vertical - 41) / 20,
          (ink * 217) / 255,
          2.8,
        ]);
    }
    const settle = Math.max(0, Math.min(1, (age - 1150) / 450));
    const takeoff = Math.max(0, Math.min(1, (age - 2350) / 450));
    const landing =
      settle *
      settle *
      (3 - 2 * settle) *
      (1 - takeoff * takeoff * (3 - 2 * takeoff));
    const flightProgress = Math.min(1, age / 1600);
    const flightDip = reduced
      ? 0
      : Math.sin(Math.PI * flightProgress) ** 2 * 0.7 * entryEase;
    const beeScale = reduced
      ? 1.15
      : (2 - 0.85 * entryEase) * (1 - 0.08 * landing);
    const flapping = !reduced && entry >= 1 && (age < 1500 || age >= 2350);
    const wingFold = flapping ? [0, 1, 2, 1][Math.floor(motion / 110) % 4] : 0;
    beePose(
      direction,
      (horizontal, vertical, ink) =>
        frame.sprite.push([
          centerX + horizontal * beeScale,
          centerY + flightDip + vertical * beeScale,
          ink,
          2.8 * beeScale,
        ]),
      wingFold,
    );
    const flightStreakAge =
      age >= 2350 ? age - 2350 : age + (motion >= 2800 ? 450 : 0);
    const flightStreakDuration = motion < 2800 && age < 2350 ? 1600 : 2050;
    const streakTime =
      current.streakPreviewTime ??
      (flightStreakAge / flightStreakDuration) * 3960;
    for (const [lane, distance, end, delay] of [
      [0, 6, 8.8, 0],
      [-1.4, 7.4, 7.84, 220],
      [1.4, 6.6, 9.7, 440],
      [-1.4, 8.346, 9.6, 660],
      [0, 9.4, 10.3, 880],
    ]) {
      const streakAge =
        (current.streakPreviewTime !== undefined
          ? streakTime
          : Math.min(streakTime, 3959.999) % 1980) - delay;
      const phase =
        current.streakPreviewTime !== undefined
          ? Math.max(0, streakAge) % 1600
          : Math.max(0, streakAge);
      const centerFadeIn = Math.min(1, phase / 150);
      const centerFadeOut = Math.max(0, Math.min(1, (1500 - phase) / 400));
      const flightInk = reduced
        ? 0
        : current.streakPreviewTime !== undefined
          ? 1
          : age >= 2350
            ? 1
            : Math.max(0, Math.min(1, (1600 - age) / 350));
      const takeoffInk = streakTime < 150 ? 0.3 * (1 - streakTime / 150) : 0;
      const pulse =
        delay === 0
          ? Math.max(
              takeoffInk,
              centerFadeIn * centerFadeIn * (3 - 2 * centerFadeIn),
            ) *
            centerFadeOut *
            centerFadeOut *
            (3 - 2 * centerFadeOut)
          : streakAge < 0 || phase >= 1100
            ? 0
            : Math.sin((Math.PI * phase) / 1100) ** 2;
      const ink = pulse * 0.65 * flightInk;
      const point = (vertical) => [
        centerX + lane * Math.cos(heading) - vertical * Math.sin(heading),
        centerY +
          flightDip +
          lane * Math.sin(heading) +
          vertical * Math.cos(heading),
      ];
      frame.streaks.push([...point(distance), ...point(end), ink]);
    }
  } else if (failed) {
    const fall = reduced ? 1 : Math.max(0, Math.min(1, (elapsed - 450) / 650));
    const horizontal = reduced
      ? 51
      : elapsed < 450
        ? 8 + (26 * elapsed) / 450
        : 34 + 17 * (2 * fall - fall * fall);
    const vertical = 22 + 20 * fall * fall;
    if (!reduced && elapsed < 1350)
      for (let step = 1; step <= 5; step += 1) {
        const prior = Math.max(0, elapsed - step * 45);
        const priorFall = Math.max(0, Math.min(1, (prior - 450) / 650));
        const fade = Math.max(0, 1 - Math.max(0, elapsed - 1100) / 250);
        dot(
          frame,
          prior < 450
            ? 8 + (26 * prior) / 450
            : 34 + 17 * (2 * priorFall - priorFall * priorFall),
          22 + 20 * priorFall * priorFall,
          0.22 * (1 - step / 6) * fade,
        );
      }
    const heading =
      2 + Math.round(Math.atan2(58 * fall, 34 * (1 - fall)) / (Math.PI / 4));
    beePose(heading, (offsetX, offsetY, ink) =>
      frame.sprite.push([horizontal + offsetX, vertical + offsetY, ink * 0.7]),
    );
    if (fall === 1)
      for (let star = 0; star < 3; star += 1) {
        const centerX = 44 + star * 7;
        const centerY = star === 1 ? 32 : 34;
        const ink = reduced
          ? 0.5
          : 0.4 + 0.18 * Math.sin((elapsed - 1100) / 450 + star * 2);
        dot(frame, centerX, centerY, ink);
        dot(frame, centerX - 1, centerY, ink * 0.7);
        dot(frame, centerX + 1, centerY, ink * 0.7);
        dot(frame, centerX, centerY - 1, ink * 0.7);
        dot(frame, centerX, centerY + 1, ink * 0.7);
      }
  } else if (offline) {
    for (const radius of [7, 12, 17]) arc(frame, 34, radius, -0.8, 0.8, 0.5);
    dot(frame, 32, 34, 0.6);
    for (let step = 0; step < 19; step += 1)
      dot(frame, 23 + step, 35 - step, 0.85);
  }
  label(
    frame,
    statusWord,
    4,
    1,
    active && !reduced
      ? 0.7 + 0.12 * Math.sin(elapsed / 450)
      : offline
        ? 0.4
        : 0.7,
    failed ? "red" : "white",
    "center",
  );
  for (const [horizontal, vertical] of [
    [4, 55],
    [6, 55],
    [5, 57],
    [4, 59],
    [6, 59],
  ])
    dot(frame, horizontal, vertical, 0.45);
  label(
    frame,
    ` ${model.valid && model.peers !== null ? formatCount(model.peers) : "--"}`,
    55,
    1,
    0.45,
    "white",
    "left",
  );
  if (showTotal) label(frame, data.total, 55, 1, 0.45, "white", "right");
  return frame;
}

const canvas = document.getElementById("display");
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const embedded =
  new URLSearchParams(location.search).get("embedded") === "true";
const invoke = embedded
  ? undefined
  : window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
const model = {
  phase: "offline",
  changed: performance.now(),
  runtime: "off",
  total: null,
  lastTotal: null,
  inflight: 0,
  batchBase: null,
  batch: null,
  rate: null,
  peers: null,
  rateHistory: [],
  lastActive: 0,
  valid: false,
};
const showTotal = true;

function metrics() {
  return {
    total: formatCount(model.total),
    request: "--",
    rate: model.rate === null ? "--" : String(Math.round(model.rate)),
  };
}
function formatCount(value) {
  if (value === null) return "--";
  if (value < 10000) return String(Math.floor(value));
  if (value < 1000000) return (value / 1000).toFixed(1) + "K";
  return (value / 1000000).toFixed(1) + "M";
}
let lastFrame = null,
  workEntry = null,
  requestWaking = false,
  returnScale = null,
  finishLandingAt = null,
  lastFlightHeading = 0,
  returnHeading = null;
const cues = {
  link: [523, 784],
  complete: [1047, 1568],
  error: [330, 220],
  offline: [294, 196],
  online: [659, 988],
  rest: [392, 262],
};
let sound = false,
  audio = null,
  lastCue = 0;
try {
  sound = localStorage.getItem("mesh-buddy-sound") === "on";
} catch {}
function chime(id) {
  const Context = window.AudioContext || window.webkitAudioContext;
  const now = performance.now();
  if (!sound || !cues[id] || !Context || now - lastCue < 400) return;
  lastCue = now;
  try {
    audio ??= new Context();
    audio.resume?.()?.catch?.(() => {});
    const start = audio.currentTime + 0.01;
    cues[id].forEach((frequency, note) => {
      const at = start + note * 0.08,
        tone = audio.createOscillator(),
        gain = audio.createGain();
      tone.type = id === "error" ? "square" : "triangle";
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(
        id === "error" ? 0.03 : 0.06,
        at + 0.01,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      tone.connect(gain).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.18);
    });
  } catch (error) {
    console.warn("Compute sound unavailable", error);
  }
}
function setPhase(phase) {
  if (!["link", "online"].includes(phase)) requestWaking = false;
  if (model.phase !== phase) {
    if (
      phase !== "online" ||
      ["error", "offline", "warm"].includes(model.phase)
    )
      chime(phase);
    if (phase === "complete" && model.phase === "active")
      returnHeading = lastFlightHeading;
    else if (!["complete", "online", "rest"].includes(phase))
      returnHeading = null;
    returnScale =
      phase === "complete" && model.phase === "active"
        ? (lastFrame?.sprite.at(-1)?.[3] ?? 2.8) / 5.6
        : null;
    workEntry =
      phase === "active" &&
      ["sleep", "rest", "online", "link", "warm"].includes(model.phase)
        ? lastFrame
        : null;
    model.phase = phase;
    model.changed = performance.now();
  }
}
function ingest(usage, status) {
  const now = performance.now();
  if (
    !status ||
    typeof status.state !== "string" ||
    !usage ||
    !Number.isFinite(usage.tokensServed) ||
    !Number.isFinite(usage.inflight)
  )
    throw new Error("Invalid mesh status");
  const total = Math.max(0, usage.tokensServed),
    inflight = Math.max(0, usage.inflight);
  const delta =
    model.lastTotal === null ? 0 : Math.max(0, total - model.lastTotal);
  if (model.lastTotal !== null && total < model.lastTotal) {
    model.batchBase = null;
    model.batch = null;
  }
  if (inflight > 0 && model.inflight === 0) {
    model.batchBase = model.lastTotal;
    model.batch =
      model.batchBase === null ? null : Math.max(0, total - model.batchBase);
  }
  if (model.batchBase !== null)
    model.batch = Math.max(0, total - model.batchBase);
  if (delta > 0 && model.inflight === 0 && inflight === 0) {
    model.batch = delta;
  }
  const completed = inflight === 0 && (model.inflight > 0 || delta > 0);
  if (
    total < model.total ||
    (inflight > 0 && model.inflight === 0) ||
    status.state !== "running"
  ) {
    model.rateHistory = [];
    model.ratePeak = 1;
  }
  model.total = total;
  model.lastTotal = total;
  model.inflight = inflight;
  model.rate = Number.isFinite(usage.tokensPerSecond)
    ? Math.max(0, usage.tokensPerSecond)
    : null;
  model.peers = Number.isFinite(usage.peers)
    ? Math.max(0, Math.floor(usage.peers))
    : null;
  model.valid = true;
  if (inflight > 0 && status.state === "running") {
    model.rateHistory.push(model.rate);
    model.rateSampleAt = now;
    model.ratePeak = Math.max(model.ratePeak || 1, model.rate || 0);
    if (model.rateHistory.length > 25) model.rateHistory.shift();
  }
  const priorRuntime = model.runtime;
  model.runtime = status.state;
  if (inflight > 0 || status.state !== "running") finishLandingAt = null;
  if (inflight > 0 || delta > 0) model.lastActive = now;
  if (status.state === "failed") setPhase("error");
  else if (status.state === "starting") {
    if (priorRuntime !== "starting") setPhase("link");
  } else if (status.state !== "running") setPhase("offline");
  else if (inflight > 0) {
    if (["sleep", "rest"].includes(model.phase) && !reduce.matches) {
      requestWaking = true;
      setPhase("link");
    } else if (!requestWaking) setPhase("active");
  } else if (completed) {
    if (model.phase === "active" && !reduce.matches) {
      if (finishLandingAt === null) {
        const flightAge =
          (Math.max(0, now - model.changed - 700) * 0.78) % 2800;
        const remaining =
          flightAge < 1600
            ? 1600 - flightAge
            : flightAge < 2150
              ? 0
              : 2800 - flightAge + 1600;
        finishLandingAt = now + remaining / 0.78 + 120;
      }
    } else setPhase("complete");
  } else if (
    priorRuntime !== "running" ||
    ["error", "offline", "link", "warm"].includes(model.phase)
  ) {
    model.lastActive = now;
    setPhase("online");
  }
}
function acceptStatus(status) {
  if (status.generation !== model.generation) {
    model.generation = status.generation;
    model.total = null;
    model.lastTotal = null;
    model.batchBase = null;
    model.batch = null;
    model.rateHistory = [];
    model.peers = null;
  }
  if (status.usage) ingest(status.usage, status);
  else {
    // Missing usage is not a disconnected worker: keep the
    // authoritative runtime state and let the widget show its idle phase.
    model.valid = status.available === true;
    model.rate = null;
    model.peers = null;
    model.inflight = 0;
    model.runtime = status.state;
    setPhase(
      status.state === "failed"
        ? "error"
        : status.state === "starting"
          ? "link"
          : status.state === "running" && model.valid
            ? "online"
            : "offline",
    );
  }
}
async function poll() {
  if (!invoke) {
    setPhase("offline");
    return;
  }
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Compute status timed out")),
      8000,
    );
  });
  try {
    const status = await Promise.race([
      invoke("mesh_compute_widget_status"),
      deadline,
    ]);
    if (status.sharing === false) {
      await invoke("plugin:window|close");
      return;
    }
    acceptStatus(status);
  } catch (error) {
    model.valid = false;
    model.rate = null;
    setPhase("offline");
    console.warn("Compute status unavailable", error);
  } finally {
    clearTimeout(timeout);
    setTimeout(poll, 1000);
  }
}
function advancePresentation(now) {
  if (finishLandingAt !== null) {
    if (
      model.phase !== "active" ||
      !model.valid ||
      model.runtime !== "running" ||
      model.inflight > 0
    )
      finishLandingAt = null;
    else if (now >= finishLandingAt) {
      finishLandingAt = null;
      setPhase("complete");
      return;
    }
  }
  if (requestWaking && model.runtime === "running" && model.valid) {
    if (model.phase === "link" && now - model.changed >= 900)
      setPhase("online");
    else if (model.phase === "online" && now - model.changed >= 350)
      setPhase(model.inflight > 0 ? "active" : "online");
  }
  if (
    model.runtime === "starting" &&
    model.phase === "link" &&
    now - model.changed >= 2000
  )
    setPhase("warm");
  if (model.runtime === "running" && model.valid && model.inflight === 0) {
    if (model.phase === "complete" && now - model.changed >= 2000)
      setPhase("online");
    if (model.phase === "online" && now - model.lastActive >= 10000)
      setPhase("rest");
    if (model.phase === "rest" && now - model.changed >= 2000)
      setPhase("sleep");
  }
}
const variations = ["bee", "orbit", "signal", "original"];
let originalStartedAt = performance.now();
let inspectedState = null;
let variation = "bee";
try {
  const saved = localStorage.getItem("mesh-buddy-variation");
  if (variations.includes(saved)) variation = saved;
} catch {}
function changeVariation(offset) {
  originalStartedAt = performance.now();
  variation =
    variations[
      (variations.indexOf(variation) + offset + variations.length) %
        variations.length
    ];
  workEntry = null;
  lastFrame = null;
  try {
    localStorage.setItem("mesh-buddy-variation", variation);
  } catch {}
}
window.addEventListener("keydown", (event) => {
  if (!document.getElementById("widget-settings").hidden) return;
  if (
    event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.repeat
  )
    return;
  if (event.key === "Escape") {
    inspectedState = null;
    render(performance.now(), false);
    event.preventDefault();
    return;
  }
  if (
    new URLSearchParams(location.search).get("preview") === "true" &&
    /^[0-9]$/.test(event.key)
  ) {
    const index = event.key === "0" ? 9 : Number(event.key) - 1;
    inspectedState = { index, started: performance.now() };
    workEntry = null;
    chime(phases[index].id);
    render(performance.now(), false);
    event.preventDefault();
    return;
  }
  if (event.key === "s") {
    sound = !sound;
    try {
      localStorage.setItem("mesh-buddy-sound", sound ? "on" : "off");
    } catch {}
    chime("online");
    render(performance.now(), false);
    event.preventDefault();
    return;
  }
  if (event.key === "-" || event.key === "=") {
    event.preventDefault();
    resize(event.key === "=" ? 1 : -1);
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    changeVariation(event.key === "ArrowLeft" ? -1 : 1);
    render(performance.now(), false);
  }
});
function drawInstrument(current, reduced) {
  const frame = buffer(),
    active = current.phase.id === "active",
    warming = current.phase.id === "warm";
  const elapsed = reduced ? 1100 : current.elapsed;
  if (warming)
    for (let row = 5; row < 59; row += 2)
      for (let column = 5; column < 59; column += 2) {
        const fill = reduced ? 0.7 : Math.min(1, elapsed / 2500);
        dot(
          frame,
          column,
          row,
          Math.max(0, Math.min(1, (row - (59 - fill * 54)) / 6)) * 0.28,
        );
      }
  if (variation === "orbit") {
    for (let point = 0; point < 82; point++) {
      const angle = (point * Math.PI * 2) / 82;
      const offset =
        (((angle - elapsed * 0.0014) % (Math.PI * 2)) + Math.PI * 2) %
        (Math.PI * 2);
      const ink = active && offset < 1.15 ? 0.84 : 0.2;
      frame.sprite.push([
        31.5 + Math.sin(angle) * 19.5,
        31.5 - Math.cos(angle) * 19.5,
        ink,
        2.9,
      ]);
    }
  } else {
    for (let column = 12; column <= 51; column++) {
      const unit = (column - 12) / 39,
        envelope = Math.sin(unit * Math.PI) ** 2;
      if (
        ["error", "offline"].includes(current.phase.id) &&
        column > 28 &&
        column < 35
      )
        continue;
      dot(
        frame,
        column,
        43 +
          (active
            ? Math.sin(unit * Math.PI * 5 - elapsed / 240) * 4.5 * envelope
            : 0),
        active ? 0.42 + 0.4 * envelope : 0.2,
      );
    }
  }
  const top = variation === "orbit" ? 29 : 24;
  label(
    frame,
    current.phase.word,
    top,
    variation === "orbit" ? 1 : 2,
    current.phase.id === "offline" ? 0.45 : 0.9,
    current.phase.id === "error" ? "red" : "white",
  );
  if (active && !reduced) {
    const sweep = ((elapsed % 1800) / 1800) * 70 - 3;
    for (let row = top; row < 34; row++)
      for (let column = 0; column < 64; column++)
        frame.white[row * 64 + column] *=
          0.72 +
          0.08 * Math.sin((elapsed * Math.PI * 2) / 1800) +
          0.2 * Math.exp(-(((column - sweep) / 4) ** 2));
  }
  label(frame, formatCount(model.total), 55, 1, 0.6);
  return frame;
}
function drawOriginal(current, reduced, liveModel = model) {
  const frame = buffer(),
    pixels = frame.white,
    GRID = 64,
    INTRO_MS = 1800,
    INTRO_FADE_MS = 350;
  const introStartedAt = originalStartedAt,
    reduceMotion = reduced;
  const model = {
    tokens: liveModel.total,
    nodes: liveModel.peers ?? "--",
    inflight: liveModel.inflight,
    tokenDelta: liveModel.batch ?? 0,
    history: Array(52)
      .fill(0)
      .concat(liveModel.rateHistory.map((value) => value ?? 0))
      .slice(-52),
  };
  const lastFrame = { set() {} };
  const FONT = {
    " ": ["000", "000", "000", "000", "000"],
    "+": ["000", "010", "111", "010", "000"],
    "-": ["000", "000", "111", "000", "000"],
    ".": ["000", "000", "000", "000", "100"],
    0: ["111", "101", "101", "101", "111"],
    1: ["010", "110", "010", "010", "111"],
    2: ["111", "001", "111", "100", "111"],
    3: ["111", "001", "111", "001", "111"],
    4: ["101", "101", "111", "001", "001"],
    5: ["111", "100", "111", "001", "111"],
    6: ["111", "100", "111", "101", "111"],
    7: ["111", "001", "010", "010", "010"],
    8: ["111", "101", "111", "101", "111"],
    9: ["111", "101", "111", "001", "111"],
    A: ["010", "101", "111", "101", "101"],
    B: ["110", "101", "110", "101", "110"],
    D: ["110", "101", "101", "101", "110"],
    E: ["111", "100", "110", "100", "111"],
    F: ["111", "100", "110", "100", "100"],
    G: ["111", "100", "101", "101", "111"],
    H: ["101", "101", "111", "101", "101"],
    I: ["111", "010", "010", "010", "111"],
    K: ["101", "101", "110", "101", "101"],
    L: ["100", "100", "100", "100", "111"],
    M: ["101", "111", "111", "101", "101"],
    N: ["110", "101", "101", "101", "101"],
    O: ["111", "101", "101", "101", "111"],
    P: ["111", "101", "111", "100", "100"],
    Q: ["111", "101", "101", "111", "001"],
    R: ["110", "101", "110", "101", "101"],
    S: ["111", "100", "111", "001", "111"],
    T: ["111", "010", "010", "010", "010"],
    U: ["101", "101", "101", "101", "111"],
    V: ["101", "101", "101", "101", "010"],
    W: ["101", "101", "101", "111", "111"],
    Y: ["101", "101", "010", "010", "010"],
    Z: ["111", "001", "010", "100", "111"],
  };

  const BEE_BODY_DOTS = [
    [8, 2],
    [10, 2],
    [9, 3],
    [7, 4],
    [8, 4],
    [9, 4],
    [10, 4],
    [11, 4],
    [7, 5],
    [9, 5],
    [11, 5],
    [7, 6],
    [8, 6],
    [9, 6],
    [10, 6],
    [11, 6],
    [7, 7],
    [11, 7],
    [7, 8],
    [8, 8],
    [9, 8],
    [10, 8],
    [11, 8],
    [7, 9],
    [11, 9],
    [8, 10],
    [9, 10],
    [10, 10],
  ];
  const BEE_LEFT_WING_DOTS = [
    [4, 5],
    [5, 5],
    [3, 6],
    [4, 6],
    [5, 6],
    [3, 7],
    [4, 7],
    [5, 7],
    [4, 8],
    [5, 8],
  ];
  const BEE_RIGHT_WING_DOTS = BEE_LEFT_WING_DOTS.map(([x, y]) => [18 - x, y]);

  function put(x, y, value = 1, target = pixels) {
    if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
    target[y * GRID + x] = Math.max(target[y * GRID + x], value);
  }

  function drawText(text, x, y, scale = 1, value = 1, target = pixels) {
    let cursor = x;
    for (const character of text) {
      const glyph = FONT[character] || FONT[" "];
      for (let row = 0; row < glyph.length; row += 1) {
        for (let column = 0; column < 3; column += 1) {
          if (glyph[row][column] !== "1") continue;
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              put(
                cursor + column * scale + dx,
                y + row * scale + dy,
                value,
                target,
              );
            }
          }
        }
      }
      cursor += (character === "." ? 2 : 4) * scale;
    }
  }

  function textWidth(text, scale = 1) {
    const width = Array.from(text).reduce(
      (sum, character) => sum + (character === "." ? 2 : 4) * scale,
      0,
    );
    return Math.max(0, width - scale);
  }

  function drawCentered(text, y, scale = 1, value = 1, target = pixels) {
    drawText(
      text,
      Math.floor((GRID - textWidth(text, scale)) / 2),
      y,
      scale,
      value,
      target,
    );
  }

  function formatCount(value) {
    if (value === null) return "--";
    if (value < 1000) return String(value);
    if (value < 1000000) return `${Math.floor(value / 100) / 10}K`;
    return `${Math.floor(value / 100000) / 10}M`;
  }

  function drawLine(x0, y0, x1, y1, value) {
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    while (true) {
      put(x0, y0, value);
      if (x0 === x1 && y0 === y1) break;
      const twice = error * 2;
      if (twice >= dy) {
        error += dy;
        x0 += sx;
      }
      if (twice <= dx) {
        error += dx;
        y0 += sy;
      }
    }
  }

  function drawSparkline(value, compact) {
    const values = model.history;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);
    const left = compact ? 6 : 4;
    const right = compact ? 57 : 59;
    const top = compact ? 40 : 45;
    const bottom = compact ? 46 : 51;
    for (let index = 1; index < values.length; index += 1) {
      const previousX =
        left + Math.round(((index - 1) / (values.length - 1)) * (right - left));
      const currentX =
        left + Math.round((index / (values.length - 1)) * (right - left));
      const previousY =
        bottom -
        Math.round(((values[index - 1] - min) / range) * (bottom - top));
      const currentY =
        bottom - Math.round(((values[index] - min) / range) * (bottom - top));
      drawLine(previousX, previousY, currentX, currentY, value);
    }
  }

  function drawSleepingZs(now, value) {
    for (let index = 0; index < 3; index += 1) {
      const phase = (now / 2800 + index / 3) % 1;
      const opacity = Math.sin(phase * Math.PI) * value * (0.45 + index * 0.14);
      const x = Math.round(
        48 + phase * 8 + Math.sin(phase * Math.PI * 2) * 1.5,
      );
      const y = Math.round(12 - phase * 10 + Math.sin(phase * Math.PI * 4));
      drawText("Z", x, y, 1, opacity);
    }
  }

  function drawRequestMotion(now) {
    const left = 8;
    const width = 48;
    const head = Math.floor((now / 55) % width);
    for (let trail = 0; trail < 7; trail += 1) {
      const x = left + ((head - trail + width) % width);
      const value = Math.max(0.12, 0.9 - trail * 0.12);
      put(x, 12, value);
      if (trail < 3) put(x, 13, value * 0.7);
    }
  }

  function drawWorkingMotion(now) {
    for (let index = 0; index < 9; index += 1) {
      const x = 11 + index * 5;
      const wave = (Math.sin(now / 180 + index * 1.35) + 1) / 2;
      const height = 2 + Math.round(wave * 7);
      for (let offset = 0; offset < height; offset += 1) {
        put(x, 17 - offset, 0.28 + (offset / height) * 0.62);
        put(x + 1, 17 - offset, 0.2 + (offset / height) * 0.45);
      }
    }

    const railPosition = 20 + Math.floor((now / 70) % 23);
    for (let trail = 0; trail < 5; trail += 1) {
      const y = 20 + ((railPosition - 20 - trail + 23) % 23);
      const value = 0.78 - trail * 0.13;
      put(2, y, value);
      put(61, 62 - y, value);
    }
  }

  function drawServedMotion(now) {
    const phase = (now / 700) % 1;
    const radius = 2 + phase * 8;
    const opacity = Math.sin(phase * Math.PI) * 0.8;
    for (let index = 0; index < 20; index += 1) {
      const angle = (index / 20) * Math.PI * 2;
      put(
        Math.round(32 + Math.cos(angle) * radius),
        Math.round(13 + Math.sin(angle) * radius * 0.48),
        opacity,
      );
    }
  }

  function drawBeeDots(dots, originX, originY, xShift, value) {
    for (const [x, y] of dots) {
      const left = originX + x * 2 + xShift;
      const top = originY + y * 2;
      put(left, top, value);
      put(left + 1, top, value);
      put(left, top + 1, value);
      put(left + 1, top + 1, value);
    }
  }

  function drawStartupBee(now) {
    const elapsed = now - introStartedAt;
    const fadeStart = INTRO_MS - INTRO_FADE_MS;
    const fade =
      elapsed > fadeStart
        ? Math.max(0, 1 - (elapsed - fadeStart) / INTRO_FADE_MS)
        : 1;
    const bob = reduceMotion ? 0 : Math.round(Math.sin(now / 210));
    const flap = reduceMotion ? 0 : Math.round((Math.sin(now / 70) + 1) * 0.75);
    const originX = 13;
    const originY = 16 + bob;
    const breath = reduceMotion ? 1 : 0.82 + Math.sin(now / 170) * 0.18;

    drawBeeDots(BEE_LEFT_WING_DOTS, originX, originY, -flap, fade * 0.72);
    drawBeeDots(BEE_RIGHT_WING_DOTS, originX, originY, flap, fade * 0.72);
    drawBeeDots(BEE_BODY_DOTS, originX, originY, 0, fade * breath);
  }

  function composeFrame(now) {
    pixels.fill(0);
    if (now - introStartedAt < INTRO_MS) {
      canvas.dataset.phase = "intro";
      drawStartupBee(now);
      lastFrame.set(pixels);
      return;
    }
    canvas.dataset.phase = "status";
    const compact = Math.min(canvas.clientWidth, canvas.clientHeight) < 280;
    const id = current.phase.id;
    const muted = id === "offline";
    const sleeping = id === "sleep" || id === "rest";
    const requesting = id === "link" || id === "recovery";
    const breath = sleeping ? 0.68 + Math.sin(now / 900) * 0.18 : 1;
    const activePulse =
      requesting || id === "active" ? 0.82 + Math.sin(now / 170) * 0.18 : 1;
    const value = muted ? 0.24 : breath * activePulse;

    drawCentered(
      current.phase.word,
      compact ? 19 : 22,
      2,
      value,
      id === "error" ? frame.red : pixels,
    );
    drawSparkline(muted ? 0.16 : 0.48, compact);
    if (sleeping) drawSleepingZs(now, breath);
    if (requesting) drawRequestMotion(now);
    if (id === "active") drawWorkingMotion(now);
    if (id === "complete") drawServedMotion(now);

    const tokens = `TOK ${formatCount(model.tokens)}`;
    const nodes = `${model.nodes}ND`;
    const counterInset = compact ? 6 : 4;
    const displaySize = Math.min(canvas.clientWidth, canvas.clientHeight);
    const counterY = compact ? 52 : displaySize >= 480 ? 56 : 55;
    drawText(tokens, counterInset, counterY, 1, muted ? 0.2 : 0.72);
    drawText(
      nodes,
      GRID - counterInset - textWidth(nodes),
      counterY,
      1,
      muted ? 0.2 : 0.72,
    );

    if (id === "complete" && model.tokenDelta > 0) {
      drawCentered(`+${formatCount(model.tokenDelta)}`, 18, 1, 0.65);
    }
    if (id === "warm") {
      const phase = Math.floor(now / 180) % 4;
      for (let index = 0; index < 3; index += 1) {
        put(29 + index * 3, 40, index <= phase % 3 ? 0.85 : 0.16);
      }
    }
    if (model.inflight > 0 && Math.floor(now / 280) % 2 === 0) {
      put(59, 4, 0.9);
      put(60, 4, 0.9);
      put(59, 5, 0.9);
      put(60, 5, 0.9);
    }
  }

  composeFrame(
    reduced ? originalStartedAt + INTRO_MS + 1100 : performance.now(),
  );
  return frame;
}
function render(now, schedule = true) {
  advancePresentation(now);
  const index =
    inspectedState?.index ??
    phases.findIndex((phase) => phase.id === model.phase);
  const elapsed = inspectedState
    ? Math.max(0, now - inspectedState.started)
    : Math.max(0, now - model.changed) *
      (requestWaking && model.phase === "link" ? 1850 / 900 : 1);
  const current = { phase: phases[index], index, elapsed };
  const frame =
    variation === "bee"
      ? draw("orbit", current, reduce.matches)
      : variation === "original"
        ? drawOriginal(current, reduce.matches)
        : drawInstrument(current, reduce.matches);
  if (
    workEntry &&
    !inspectedState &&
    !reduce.matches &&
    now - model.changed < 850
  ) {
    const progress = Math.max(0, (now - model.changed) / 850);
    const blend = progress * progress * (3 - 2 * progress);
    for (let address = 0; address < 4096; address++) {
      frame.white[address] =
        frame.white[address] * blend + workEntry.white[address] * (1 - blend);
      frame.red[address] =
        frame.red[address] * blend + workEntry.red[address] * (1 - blend);
    }
  } else workEntry = null;
  lastFrame = frame;
  const width = Math.max(
    1,
    Math.round(canvas.clientWidth * (devicePixelRatio || 1)),
  );
  const height = Math.max(
    1,
    Math.round(canvas.clientHeight * (devicePixelRatio || 1)),
  );
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  paintFrame(
    frame,
    canvas.getContext("2d"),
    width,
    height,
    getComputedStyle(document.documentElement),
  );
  canvas.dispatchEvent(
    new CustomEvent("compute-frame", {
      detail: {
        paint: (context, width, height, palette) =>
          paintFrame(frame, context, width, height, palette),
      },
    }),
  );
  canvas.dataset.phase = model.phase;
  canvas.dataset.total = String(model.total ?? "");
  canvas.dataset.batch = String(model.batch ?? "");
  canvas.setAttribute(
    "aria-label",
    `${inspectedState ? "Visual state preview, Escape returns to live. " : ""}Compute: ${phases[index].label}. Sound ${sound ? "on" : "off"}. ${model.valid ? "" : "Status unavailable. "}${showTotal ? "Runtime session total " + formatCount(model.total) + " tokens. " : ""}${model.phase === "active" ? "Per-request token count unavailable. " : ""}`,
  );
  if (schedule) requestAnimationFrame(render);
}

function paintFrame(frame, context, width, height, palette) {
  const scale = Math.min(width, height) / 512;
  if (embedded)
    context.setTransform(
      scale,
      0,
      0,
      scale,
      (width - scale * 512) / 2,
      (height - scale * 512) / 2,
    );
  else context.setTransform(width / 512, 0, 0, height / 512, 0, 0);
  const foreground =
    palette.getPropertyValue("--text-standard").trim() || "white";
  const accent = palette.getPropertyValue("--text-danger").trim() || "red";
  context.fillStyle =
    palette.getPropertyValue("--surface-inset").trim() || "black";
  context.fillRect(0, 0, 512, 512);
  for (let address = 0; address < 4096; address++) {
    const white = frame.white[address],
      red = frame.red[address],
      intensity = Math.max(white, red);
    if (intensity < 0.01) continue;
    const redWeight = red / (white + red || 1);
    context.globalAlpha = intensity;
    context.fillStyle = `color-mix(in srgb, ${accent} ${redWeight * 100}%, ${foreground})`;
    context.beginPath();
    context.arc(
      (address % 64) * 8 + 4,
      Math.floor(address / 64) * 8 + 4,
      2.9,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  for (const [horizontal, vertical, ink, radius = 2.8] of frame.sprite) {
    context.globalAlpha = ink;
    context.fillStyle = foreground;
    context.beginPath();
    context.arc(horizontal * 8 + 4, vertical * 8 + 4, radius, 0, Math.PI * 2);
    context.fill();
  }
  for (const [startX, startY, endX, endY, ink] of frame.streaks) {
    context.globalAlpha = ink;
    context.strokeStyle = foreground;
    context.lineWidth = 2.8;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(startX * 8 + 4, startY * 8 + 4);
    context.lineTo(endX * 8 + 4, endY * 8 + 4);
    context.stroke();
  }
  context.globalAlpha = 1;
}
if (embedded) {
  document.body.classList.add("embedded");
  document.getElementById("settings-toggle").hidden = true;
  document.getElementById("close").hidden = true;
  sound = false;
  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== location.origin ||
      event.data?.type !== "compute-activity"
    )
      return;
    try {
      acceptStatus(event.data.status);
    } catch {
      model.valid = false;
      setPhase("offline");
    }
  });
} else poll();
requestAnimationFrame(render);
const settings = document.getElementById("widget-settings");
const settingsToggle = document.getElementById("settings-toggle");
function showSettings(open) {
  settings.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("close").focus();
  else settingsToggle.focus();
}
settingsToggle.addEventListener("click", () => showSettings(settings.hidden));
window.addEventListener("keydown", (event) => {
  if (embedded || event.repeat) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === ",") {
    event.preventDefault();
    showSettings(true);
  } else if (event.key === "Escape" && !settings.hidden) {
    event.preventDefault();
    showSettings(false);
  }
});
document.getElementById("close").addEventListener("click", () => {
  if (invoke) invoke("plugin:window|close").catch(() => {});
});

// A still click cycles designs; moving past a small threshold hands off to a native drag.
let press = null,
  wheel = 0;
canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 0) press = { x: event.screenX, y: event.screenY };
});
canvas.addEventListener("pointermove", (event) => {
  if (
    !press ||
    Math.hypot(event.screenX - press.x, event.screenY - press.y) < 4
  )
    return;
  press = null;
  if (invoke) invoke("plugin:window|start_dragging").catch(() => {});
});
canvas.addEventListener("pointerup", () => {
  if (!press) return;
  press = null;
  changeVariation(1);
  render(performance.now(), false);
});
canvas.addEventListener("pointercancel", () => {
  press = null;
});
function resize(steps) {
  const current = Math.min(innerWidth, innerHeight);
  const next = Math.max(
    96,
    Math.min(320, Math.round(current / 16) * 16 + steps * 16),
  );
  if (next !== current && invoke)
    invoke("plugin:window|set_size", {
      value: { Logical: { width: next, height: next } },
    }).catch(() => {});
}
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    wheel += event.deltaY;
    if (Math.abs(wheel) < 40) return;
    resize(wheel < 0 ? 1 : -1);
    wheel = 0;
  },
  { passive: false },
);
