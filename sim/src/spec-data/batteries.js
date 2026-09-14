// Battery catalogue, spec §12.2 (donnees/batteries.json), 17 entries.
//
// HARDWARE FACTS ONLY, and all of them are: a pack has a cell count, a
// capacity, a mass and a discharge rating. Nothing here needs recalibrating.
// framePropSizeMin/Max is the fitment window, not a physical property of the
// cells — it says which airframes the pack is meant for.

export const SPEC_BATTERIES = {
	"1s-450": { id: "1s-450", name: "1s 450mah", cells: 1, capacityMah: 450, massG: 13, dischargeC: 100, framePropSizeMin: 0.5, framePropSizeMax: 2 },
	"1s-660": { id: "1s-660", name: "1s 660mah", cells: 1, capacityMah: 660, massG: 16, dischargeC: 90, framePropSizeMin: 0.5, framePropSizeMax: 2 },
	"2s-300": { id: "2s-300", name: "2s 300mah", cells: 2, capacityMah: 300, massG: 18, dischargeC: 75, framePropSizeMin: 1, framePropSizeMax: 2.5 },
	"2s-420": { id: "2s-420", name: "2s 420mah", cells: 2, capacityMah: 420, massG: 22, dischargeC: 80, framePropSizeMin: 1, framePropSizeMax: 2.5 },
	"2-s550": { id: "2-s550", name: "2s 550mah", cells: 2, capacityMah: 550, massG: 35, dischargeC: 70, framePropSizeMin: 1, framePropSizeMax: 2.5 },
	"4s-450": { id: "4s-450", name: "4s 450mah", cells: 4, capacityMah: 450, massG: 62, dischargeC: 70, framePropSizeMin: 3, framePropSizeMax: 4.099999904632568 },
	"4s-650": { id: "4s-650", name: "4s 650mah", cells: 4, capacityMah: 650, massG: 87, dischargeC: 100, framePropSizeMin: 3, framePropSizeMax: 4.099999904632568 },
	"4s-750": { id: "4s-750", name: "4s 750mah", cells: 4, capacityMah: 750, massG: 90, dischargeC: 100, framePropSizeMin: 3, framePropSizeMax: 4.099999904632568 },
	"4s-850": { id: "4s-850", name: "4s 850mah", cells: 4, capacityMah: 850, massG: 100, dischargeC: 130, framePropSizeMin: 3, framePropSizeMax: 4.099999904632568 },
	"4s-1300": { id: "4s-1300", name: "4s 1300mah", cells: 4, capacityMah: 1300, massG: 156, dischargeC: 150, framePropSizeMin: 3, framePropSizeMax: 6.099999904632568 },
	"4s-1550": { id: "4s-1550", name: "4s 1550mah", cells: 4, capacityMah: 1550, massG: 167, dischargeC: 130, framePropSizeMin: 4, framePropSizeMax: 6.099999904632568 },
	"6s-1050": { id: "6s-1050", name: "6s 1050mah", cells: 6, capacityMah: 1050, massG: 170, dischargeC: 95, framePropSizeMin: 5, framePropSizeMax: 8 },
	"6s-1300": { id: "6s-1300", name: "6s 1300mah", cells: 6, capacityMah: 1300, massG: 201, dischargeC: 130, framePropSizeMin: 5, framePropSizeMax: 8 },
	"6s-1400": { id: "6s-1400", name: "6s 1400mah", cells: 6, capacityMah: 1400, massG: 222, dischargeC: 150, framePropSizeMin: 5, framePropSizeMax: 8 },
	"6s-1700": { id: "6s-1700", name: "6s 1700mah", cells: 6, capacityMah: 1700, massG: 262, dischargeC: 100, framePropSizeMin: 5, framePropSizeMax: 8 },
	"6s-3000": { id: "6s-3000", name: "6s 3000mah", cells: 6, capacityMah: 3000, massG: 403, dischargeC: 120, framePropSizeMin: 6, framePropSizeMax: 8 },
	"6s-4500": { id: "6s-4500", name: "6s 4500mah", cells: 6, capacityMah: 4500, massG: 685, dischargeC: 95, framePropSizeMin: 8, framePropSizeMax: 12 },
};

export const SPEC_BATTERY_IDS = Object.keys(SPEC_BATTERIES);

// Nominal LiPo cell voltages. The spec's criterion 3 (§13) is quoted at 4.0 V
// per cell, which is a cell under load, not a full one.
export const CELL_VOLTS_FULL = 4.2;
export const CELL_VOLTS_LOADED = 4.0;
