/**
 * Level progression.
 *
 * Each level has:
 *   * an id       (0..10 + 'red' + 'dark' tags)
 *   * a palette   (selected inside World via loadLevel)
 *   * a stability — how fast the simulation decays. Lower = faster decay.
 */

export const LEVELS = [
  { id: 0,  name: 'GROUND STATE',
    prompt: 'WELCOME. WALK FORWARD. NEVER STOP.',
    sub:    'If you hear the hum, move.',
    stability: 1.0,
    bgAudio: 'ground',
    spawnProbBase: 0.005,
    timeToWinSec: 90
  },
  { id: 1,  name: 'TUNNELING EFFECT',
    prompt: 'INDUSTRIAL CONCRETE. SOME WALLS ARE SUGGESTIONS.',
    sub:    'Sprint to phase. Sanity drains.',
    stability: 0.95,
    bgAudio: 'industrial',
    spawnProbBase: 0.006,
    timeToWinSec: 95
  },
  { id: 2,  name: 'BLOCKED DUCTS',
    prompt: 'VENTILATION. OR SOMETHING BREATHING.',
    sub:    'The walls are warmer here.',
    stability: 0.9,
    bgAudio: 'ducts',
    spawnProbBase: 0.007,
    timeToWinSec: 100
  },
  { id: 3,  name: 'HIGH-VOLTAGE STATION',
    prompt: 'ELECTRICAL HAZARD. DO NOT TOUCH.',
    sub:    'Lights fail. Your steps echo.',
    stability: 0.85,
    bgAudio: 'volts',
    spawnProbBase: 0.008,
    timeToWinSec: 105
  },
  { id: 4,  name: 'ABANDONED OFFICE',
    prompt: 'DECOHERENCE PHASE. DESKS, ROUTINES, ALGORITHMS.',
    sub:    'Decoys are spawning. Trust the loudest hum.',
    stability: 0.8,
    bgAudio: 'office',
    spawnProbBase: 0.009,
    timeToWinSec: 110
  },
  { id: 5,  name: 'THE HOTEL',
    prompt: 'NO VACANCY.',
    sub:    'Lingering warmth.',
    stability: 0.72,
    bgAudio: 'hotel',
    spawnProbBase: 0.011,
    timeToWinSec: 115
  },
  { id: 6,  name: 'DARK MATTER',
    prompt: 'ALL SIGNALS LOST. NAVIGATE BY SOUND.',
    sub:    'Listen. The binary rain is the only thing left.',
    stability: 0.6,
    bgAudio: 'void',
    spawnProbBase: 0.014,
    timeToWinSec: 120
  },
  { id: 'red', name: 'RED SHIFT',
    prompt: 'THE WALL IS COMING. RUN.',
    sub:    'Do. Not. Stop.',
    stability: 0.4,
    bgAudio: 'redshift',
    spawnProbBase: 0.0,  // spawning handled differently
    timeToWinSec: 60
  },
  { id: 10, name: 'THE SINGULARITY',
    prompt: 'TEXTURES FAIL. GEOMETRY FAILS. YOU ARE OBSERVED.',
    sub:    'Find the stable door. Disconnect.',
    stability: 0.25,
    bgAudio: 'glitch',
    spawnProbBase: 0.018,
    timeToWinSec: 90
  }
];
