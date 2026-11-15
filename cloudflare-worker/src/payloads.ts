// Eingaben der oeffentlichen Endpunkte bereinigen (nur erlaubte Felder).

// Aus dem Kunden-Objekt nur die Felder uebernehmen, die fn_place_order und
// fn_submit_custom_request lesen. existing_customer_id wird bewusst NICHT
// uebernommen: das Storefront nutzt es nicht, und ein anonymer Aufrufer
// koennte damit sonst auf einen fremden Kunden bestellen bzw. anfragen.
export const CUSTOMER_FIELDS = ["first_name", "last_name", "phone", "email", "pickup_method", "message"] as const;

export function sanitizeCustomer(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	const customer: Record<string, unknown> = {};
	for (const field of CUSTOMER_FIELDS) {
		if (source[field] !== undefined) customer[field] = source[field];
	}
	return customer;
}

// Nur die bekannten Parameter von fn_place_order weiterreichen.
export function sanitizeOrderPayload(payload: unknown): Record<string, unknown> | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const { p_cart_session_id, p_customer } = payload as Record<string, unknown>;
	const customer = sanitizeCustomer(p_customer);
	if (customer === null) return null;
	return { p_cart_session_id, p_customer: customer };
}

// Nur die bekannten Parameter von fn_submit_custom_request weiterreichen.
// Storage-Pfad und 3mf-Schaetzwerte kommen nie vom Client (das Formular
// sendet keine Dateien) und werden hier fest auf null gesetzt.
export const CUSTOM_REQUEST_FIELDS = [
	"p_makerworld_link",
	"p_own_image",
	"p_desired_size",
	"p_qty",
	"p_message",
	"p_color_id",
	"p_finish_id",
	"p_slot_colors",
] as const;

export function sanitizeCustomRequestPayload(payload: unknown): Record<string, unknown> | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const source = payload as Record<string, unknown>;
	const customer = sanitizeCustomer(source.p_customer);
	if (customer === null) return null;
	const result: Record<string, unknown> = { p_customer: customer };
	for (const field of CUSTOM_REQUEST_FIELDS) {
		result[field] = source[field] ?? null;
	}
	result.p_slice_file_upload = null;
	result.p_estimated_weight_g = null;
	result.p_estimated_print_minutes = null;
	return result;
}
