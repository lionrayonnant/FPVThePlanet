import { generateTargetScan, resolveTarget } from './target-model.mjs';
import { openSession, validateSession } from './session-model.mjs';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const scan = generateTargetScan({ seed: 'route-seed', count: 4 });
const target = resolveTarget(scan, 2);
const s = validateSession(openSession({ seq: 1, targetSeq: 1, operatorId: 'op-x', area: 'kyiv', weatherSnapshot: null, target }));
check('la session serveur porte la cible régénérée', s.target.family === scan.candidates[2]._family);

// régénération identique
const again = resolveTarget(generateTargetScan({ seed: 'route-seed', count: 4 }), 2);
check('régénération déterministe', again.family === target.family && again.signal.rssiDbm === target.signal.rssiDbm);

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
