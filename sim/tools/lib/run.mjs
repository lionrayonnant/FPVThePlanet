// Lancement de sous-processus avec relais de logs, partagé par l'orchestrateur
// d'ajout de carte et par les modules fournisseur.

import { spawn } from 'node:child_process';

export class Cancelled extends Error {
	constructor() { super('annulé'); this.name = 'Cancelled'; }
}

// Lance une commande en relayant chaque ligne de stdout ET de stderr à onLog.
// Le Go exporter écrit toute sa progression sur stderr et réserve stdout au JSON
// de --plan, alors que prep.mjs écrit sur stdout : il faut les deux.
export function run(cmd, args, cwd, { onLog, signal }) {
	return new Promise((resolve, reject) => {
		onLog?.({ stream: 'meta', line: `$ ${cmd} ${args.join(' ')}` });
		const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

		// Une ligne peut arriver en plusieurs chunks : on tamponne jusqu'au \n.
		const pump = (stream, name) => {
			let buf = '';
			stream.setEncoding('utf8');
			stream.on('data', (d) => {
				buf += d;
				const lines = buf.split('\n');
				buf = lines.pop();
				for (const line of lines) onLog?.({ stream: name, line });
			});
			stream.on('end', () => { if (buf) onLog?.({ stream: name, line: buf }); });
		};
		pump(child.stdout, 'stdout');
		pump(child.stderr, 'stderr');

		let cancelled = false;
		const abort = () => {
			cancelled = true;
			// SIGTERM d'abord ; `go run` relaie mal les signaux à son enfant, donc
			// on repasse en SIGKILL si le processus s'accroche.
			child.kill('SIGTERM');
			setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref?.();
		};
		if (signal) {
			if (signal.aborted) return void abort();
			signal.addEventListener('abort', abort, { once: true });
		}

		child.on('error', reject);
		child.on('close', (code) => {
			signal?.removeEventListener('abort', abort);
			if (cancelled) reject(new Cancelled());
			else if (code === 0) resolve();
			else reject(new Error(`${cmd} exited with code ${code}`));
		});
	});
}
