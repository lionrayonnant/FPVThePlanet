"use strict";

// centers and scales all *.obj and saves results as *.2.obj
// can also keep 3d viewers from jittering

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const OBJ_DIR = './downloaded_files/obj';

for (let i of fs.readdirSync(OBJ_DIR)) {
	i = path.resolve(OBJ_DIR, i);
	if (!fs.statSync(i).isDirectory()) continue;

	for (let j of fs.readdirSync(i)) {
		j = path.resolve(i, j);
		if (!/\.obj$/.test(j) || /\.2\.obj$/.test(j)) continue;
		if (!fs.statSync(j).isFile()) continue;

		scaleMoveObj(j, `${j.match(/(.*)\.obj$/)[1]}.2.obj`);
	}
}

const SCALE = 10;

function scaleMoveObj(file_in, file_out) {

	if (fs.existsSync(file_out)) {
		fs.unlinkSync(file_out);
	}

	const io = readline.createInterface({
		input: fs.createReadStream(file_in),
		terminal: false,
	});

	let min_x = Infinity, max_x = -Infinity;
	let min_y = Infinity, max_y = -Infinity;
	let min_z = Infinity, max_z = -Infinity;
	let sum_x = 0, sum_y = 0, sum_z = 0, count = 0;

	io.on('line', line => {
		if (!/^v /.test(line))
			return;
		let [x, y, z] = line.split(' ').slice(1).map(parseFloat);
		min_x = Math.min(x, min_x);
		min_y = Math.min(y, min_y);
		min_z = Math.min(z, min_z);
		max_x = Math.max(x, max_x);
		max_y = Math.max(y, max_y);
		max_z = Math.max(z, max_z);
		sum_x += x; sum_y += y; sum_z += z; count++;
	}).on('close', () => {
		const center_x = (max_x + min_x) / 2;
		const center_y = (max_y + min_y) / 2;
		const center_z = (max_z + min_z) / 2;
		const distance_x = Math.abs(max_x - min_x);
		const distance_y = Math.abs(max_y - min_y);
		const distance_z = Math.abs(max_z - min_z);
		const max_distance = Math.max(distance_x, distance_y, distance_z);

		// source coords are ECEF (earth-centered), so "up" at this spot on
		// earth's surface is just the outward radial direction - approximated
		// here by the direction from earth's center to the model's centroid,
		// since the model itself is tiny compared to earth's radius.
		// aligned to the file's Y axis because Blender's default obj importer
		// treats Y-up as up and converts it to its own Z-up on import.
		const up = normalize([sum_x / count, sum_y / count, sum_z / count]);
		const R = rotationAlign(up, [0, 1, 0]);

		const io = readline.createInterface({
			input: fs.createReadStream(file_in),
			output: fs.createWriteStream(file_out),
		});

		io.on('line', line => {
			if (!/^v /.test(line))
				return io.output.write(`${line}\n`);
			let [x, y, z] = line.split(' ').slice(1).map(parseFloat);
			[x, y, z] = applyMatrix(R, [x - center_x, y - center_y, z - center_z]);
			x = x / max_distance * SCALE;
			y = y / max_distance * SCALE;
			z = z / max_distance * SCALE;
			io.output.write(`v ${x} ${y} ${z}\n`);
		}).on('close', () => {
			console.error(`done. saved as ${file_out}`);
		});
	});
}

function normalize(v) {
	const len = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// 3x3 rotation matrix (row-major) that rotates unit vector a onto unit vector b
function rotationAlign(a, b) {
	const v = cross(a, b);
	const c = dot(a, b);
	const s = Math.hypot(v[0], v[1], v[2]);
	if (s < 1e-12) {
		return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	}
	const [vx, vy, vz] = v;
	const K = [[0, -vz, vy], [vz, 0, -vx], [-vy, vx, 0]];
	const K2 = matMul(K, K);
	const factor = (1 - c) / (s * s);
	const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++)
			R[i][j] += K[i][j] + K2[i][j] * factor;
	return R;
}

function matMul(A, B) {
	const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++)
			for (let k = 0; k < 3; k++)
				R[i][j] += A[i][k] * B[k][j];
	return R;
}

function applyMatrix(R, v) {
	return [
		R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
		R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
		R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
	];
}