import { describe, expect, it } from "vitest";
import {
	decodeHtmlEntities,
	descriptionPrompt,
	generateDescriptionDe,
	parseDescriptionRequest,
	cleanDescription,
	parsePlateAnalysis,
	analysisPrompt,
	extractMakerWorldModelId,
	parseMakerWorldPlates,
	parseSizeHint,
	pickPrintProfile,
	limitBody,
	listPrintProfiles,
	sanitizeCustomRequestPayload,
	translatePlateNames,
	sanitizeOrderPayload,
} from "./index";

describe("sanitizeOrderPayload", () => {
	it("entfernt existing_customer_id und unbekannte Felder", () => {
		const out = sanitizeOrderPayload({
			p_cart_session_id: "c1",
			evil: 1,
			p_customer: { first_name: "A", existing_customer_id: "x", is_admin: true, message: "hi" },
		});
		expect(out).toEqual({ p_cart_session_id: "c1", p_customer: { first_name: "A", message: "hi" } });
	});
	it("lehnt Nicht-Objekte ab", () => {
		expect(sanitizeOrderPayload(null)).toBeNull();
		expect(sanitizeOrderPayload({ p_customer: [] })).toBeNull();
	});
});

describe("sanitizeCustomRequestPayload", () => {
	it("entfernt existing_customer_id und setzt Datei-/Schaetzfelder auf null", () => {
		const out = sanitizeCustomRequestPayload({
			p_customer: { first_name: "A", existing_customer_id: "x" },
			p_qty: 2,
			p_slice_file_upload: "pfad",
			p_estimated_weight_g: 99,
			extra: true,
		})!;
		expect(out.p_customer).toEqual({ first_name: "A" });
		expect(out.p_qty).toBe(2);
		expect(out.p_slice_file_upload).toBeNull();
		expect(out.p_estimated_weight_g).toBeNull();
		expect(out.p_estimated_print_minutes).toBeNull();
		expect("extra" in out).toBe(false);
	});
	it("lehnt fehlendes p_customer ab", () => {
		expect(sanitizeCustomRequestPayload({ p_qty: 1 })).toBeNull();
	});
});

describe("extractMakerWorldModelId", () => {
	it("liest die ID", () => {
		expect(extractMakerWorldModelId("https://makerworld.com/en/models/921270-titel")).toEqual({ ok: true, id: "921270" });
	});
	it("lehnt fremde Hosts ab", () => {
		expect(extractMakerWorldModelId("https://evilmakerworld.com/models/1").ok).toBe(false);
		expect(extractMakerWorldModelId("ftp://makerworld.com/models/1").ok).toBe(false);
	});
});

describe("parseSizeHint", () => {
	it("erkennt Dreiermass", () => {
		expect(parseSizeHint("Size 185 mm x 135 mm x 135 mm")).toBe("185 × 135 × 135 mm");
	});
	it("erkennt Hoehe", () => {
		expect(parseSizeHint("height 60 mm")).toBe("60 mm");
	});
	it("ignoriert Schichthoehe", () => {
		expect(parseSizeHint("layer height 0.2 mm")).toBeNull();
	});
	it("null bei Nicht-Text", () => {
		expect(parseSizeHint(undefined)).toBeNull();
	});
});

describe("decodeHtmlEntities", () => {
	it("loest Mehrfachkodierung auf", () => {
		expect(decodeHtmlEntities("&amp;#39;decor")).toBe("'decor");
	});
});

describe("parseMakerWorldPlates", () => {
	it("liest Platten und verwirft unbrauchbare Filamente", () => {
		const plates = parseMakerWorldPlates({
			extention: {
				modelInfo: {
					plates: [{ index: 2, prediction: 3600, weight: 12.5, filaments: [{ id: 1, color: "#aabbcc", usedG: 5 }, { id: 2, usedG: 0 }] }],
				},
			},
		});
		expect(plates).toEqual([
			{ plateNo: 2, printMinutes: 60, weightG: 12.5, imageUrl: null, filaments: [{ slot: "1", type: null, color: "#AABBCC", usedG: 5 }], name: null, nameDe: null },
		]);
	});
	it("leeres Array bei unbekanntem Format", () => {
		expect(parseMakerWorldPlates(undefined)).toEqual([]);
	});
	it("liest den Plattennamen", () => {
		const [plate] = parseMakerWorldPlates({ extention: { modelInfo: { plates: [{ index: 1, name: " Scarf &amp; Hat " }] } } });
		expect(plate.name).toBe("Scarf & Hat");
		const [empty] = parseMakerWorldPlates({ extention: { modelInfo: { plates: [{ index: 1, name: "" }] } } });
		expect(empty.name).toBeNull();
	});
});

describe("translatePlateNames", () => {
	const plate = (name: string | null) => ({ plateNo: 1, printMinutes: null, weightG: null, imageUrl: null, filaments: [], name, nameDe: null });
	it("uebersetzt jeden Namen einmal", async () => {
		const calls: string[] = [];
		const env = { AI: { run: async (_m: string, o: { messages: { content: string }[] }) => {
			calls.push(o.messages[1].content);
			return { response: o.messages[1].content === "Nose" ? "Nase" : "„Schal & Hut“" };
		} } } as never;
		const out = await translatePlateNames(env, [plate("Nose"), plate("Scarf & Hat"), plate("Nose"), plate(null)]);
		expect(out.map((p) => p.nameDe)).toEqual(["Nase", "Schal & Hut", "Nase", null]);
		expect(calls).toEqual(["Nose", "Scarf & Hat"]);
	});
	it("ohne AI-Binding bleibt nameDe leer", async () => {
		const out = await translatePlateNames({} as never, [plate("Nose")]);
		expect(out[0].nameDe).toBeNull();
	});
});

describe("pickPrintProfile", () => {
	const a1 = { title: "A1", extention: { modelInfo: { compatibility: { devProductName: "A1" } } } };
	const x2d = { title: "X2D", extention: { modelInfo: { compatibility: { devProductName: "X2D" } } } };
	it("waehlt Profil des Zieldruckers exakt", () => {
		const r = pickPrintProfile([a1, x2d], { name: "Mein X2D", model: "X2D" });
		expect(r.instance).toBe(x2d);
		expect(r.profile?.isTargetPrinter).toBe(true);
	});
	it("A1 trifft nicht A1 mini", () => {
		const r = pickPrintProfile([x2d], { name: "x", model: "A1 mini" });
		expect(r.profile?.isTargetPrinter).toBe(false);
	});
	it("ohne Ziel: erstes Profil", () => {
		expect(pickPrintProfile([a1, x2d], null).instance).toBe(a1);
	});
	it("liefert die Profil-ID fuer den 3D-Link", () => {
		expect(pickPrintProfile([{ ...a1, id: 2135106 }], null).profile?.profileId).toBe(2135106);
		expect(pickPrintProfile([a1], null).profile?.profileId).toBeNull();
	});
});

describe("Beschreibung", () => {
	it("baut den Prompt nur aus eigenen Angaben", () => {
		expect(descriptionPrompt({ title: "Schneemann", tags: ["winter"], sizeHint: "8 cm", parts: ["Körper", "Schal", "Körper"] })).toBe(
			"Titel: Schneemann\nStichwörter: winter\nGröße: 8 cm\nTeile: Körper, Schal",
		);
		expect(descriptionPrompt({ title: " ", tags: [], sizeHint: null, parts: [] })).toBeNull();
	});
	it("bereinigt die Antwort und kuerzt am Satzende", async () => {
		const long = "Ein Satz. ".repeat(80);
		const env = (response: string) => ({ AI: { run: async () => ({ response }) } }) as never;
		const input = { title: "X", tags: [], sizeHint: null, parts: [] };
		expect(await generateDescriptionDe(env("„Hallo  Welt.“"), input)).toBe("Hallo Welt.");
		const cut = await generateDescriptionDe(env(long), input);
		expect(cut!.length).toBeLessThanOrEqual(300);
		expect(cut!.endsWith(".")).toBe(true);
		expect(await generateDescriptionDe({} as never, input)).toBeNull();
	});
});

describe("parseDescriptionRequest", () => {
	it("liest und begrenzt die Eingaben", () => {
		expect(parseDescriptionRequest({ title: " Elch ", tags: ["a", 3, " b "], sizeHint: "", parts: ["Kopf"] })).toEqual({
			title: "Elch",
			tags: ["a", "b"],
			sizeHint: null,
			parts: ["Kopf"],
		});
		expect(parseDescriptionRequest({ title: "" })).toBeNull();
		expect(parseDescriptionRequest(null)).toBeNull();
	});
});

describe("cleanDescription", () => {
	it("entfernt 'nicht angegeben' und 'aus einem Teil'", () => {
		expect(cleanDescription("Hirsch-Laterne, Größe nicht angegeben.")).toBe("Hirsch-Laterne.");
		expect(cleanDescription("Das Rentier ist 8,3cm groß und besteht aus einem Teil.")).toBe("Das Rentier ist 8,3cm groß.");
		expect(cleanDescription("Ein Hirsch im Japandi-Stil. Größe und Teilezahl sind nicht angegeben.")).toBe("Ein Hirsch im Japandi-Stil.");
		expect(cleanDescription("Dackel-Kugel als Deko. Sie besteht aus einem Teil.")).toBe("Dackel-Kugel als Deko.");
	});
	it("laesst normale Texte unveraendert", () => {
		expect(cleanDescription("Schneemann aus Körper, Hut und Schal.")).toBe("Schneemann aus Körper, Hut und Schal.");
	});
});

describe("Platten-Einordnung", () => {
	const plate = (plateNo: number, weightG: number, printMinutes: number) => ({
		plateNo, printMinutes, weightG, imageUrl: null, filaments: [], name: null, nameDe: null,
	});
	const plates = [plate(1, 76, 216), plate(2, 63, 202), plate(3, 23, 76)];
	it("liest Varianten-Vorschlag und verwirft unbekannte Platten", () => {
		const raw = 'Hier: {"mode":"variants","confident":true,"reason":"Einteilig oder zweiteilig","partNames":{"1":"Komplett","2":"Außen","3":"Bauch","9":"x"},"variants":[{"name":"Einteilig","plates":[1]},{"name":"Zweifarbig","plates":[3,2,9]}]}';
		expect(parsePlateAnalysis(raw, plates)).toEqual({
			mode: "variants",
			confident: true,
			reason: "Einteilig oder zweiteilig",
			partNames: { "1": "Komplett", "2": "Außen", "3": "Bauch" },
			variants: [
				{ name: "Einteilig", plateNos: [1] },
				{ name: "Zweifarbig", plateNos: [2, 3] },
			],
		});
	});
	it("Varianten mit nur einer Gruppe gelten als unsicher, Unsinn als null", () => {
		expect(parsePlateAnalysis('{"mode":"variants","confident":true,"variants":[{"name":"A","plates":[1]}]}', plates)?.confident).toBe(false);
		expect(parsePlateAnalysis('{"mode":"quatsch"}', plates)).toBeNull();
		expect(parsePlateAnalysis("kein json", plates)).toBeNull();
	});
	it("baut den Prompt aus Gewicht, Zeit und Bildbeschreibung", () => {
		expect(analysisPrompt("Pinguin", [plates[0]], ["a penguin"])).toBe(
			"Modell: Pinguin\nPlatte 1, 76 g, 216 min, 1 Filament(e), Bild: a penguin",
		);
	});
});

describe("Profilauswahl", () => {
	const x2d = {
		id: 11,
		title: "2 Farben",
		extention: { modelInfo: { compatibility: { devProductName: "X2D" }, plates: [{ index: 1, filaments: [{ id: 1, usedG: 54 }, { id: 2, usedG: 6 }] }] } },
	};
	const p1s = {
		id: 22,
		title: "Einfarbig",
		extention: { modelInfo: { compatibility: { devProductName: "P1S" }, plates: [{ index: 1, filaments: [{ id: 1, usedG: 36 }] }] } },
	};
	const target = { name: "Mein X2D", model: "X2D" };
	it("listet Profile mit Mehrfarb- und Ziel-Kennzeichen", () => {
		expect(listPrintProfiles([x2d, p1s], target)).toEqual([
			{ id: 11, printer: "X2D", title: "2 Farben", plateCount: 1, multicolor: true, isTarget: true },
			{ id: 22, printer: "P1S", title: "Einfarbig", plateCount: 1, multicolor: false, isTarget: false },
		]);
	});
	it("nimmt das gewaehlte Profil statt des Standard-Druckers", () => {
		const r = pickPrintProfile([x2d, p1s], target, 22);
		expect(r.instance).toBe(p1s);
		expect(r.profile?.isTargetPrinter).toBe(false);
		expect(pickPrintProfile([x2d, p1s], target, 999).instance).toBe(x2d);
	});
});

describe("limitBody", () => {
	it("laesst kleine Bodies durch und puffert sie", async () => {
		const req = new Request("https://x/api", { method: "POST", body: "hallo" });
		const out = await limitBody(req, 10);
		expect(await out!.text()).toBe("hallo");
	});
	it("lehnt zu grosse Bodies auch ohne Content-Length ab", async () => {
		const stream = new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array(8));
				c.enqueue(new Uint8Array(8));
				c.close();
			},
		});
		const req = new Request("https://x/api", { method: "POST", body: stream, duplex: "half" } as RequestInit);
		expect(await limitBody(req, 10)).toBeNull();
	});
});
