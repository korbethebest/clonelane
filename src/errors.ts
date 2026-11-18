export class ClonelaneError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ClonelaneError";
		this.code = code;
	}
}

export function fail(code: string, message: string): never {
	throw new ClonelaneError(code, message);
}
