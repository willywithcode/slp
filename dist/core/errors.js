/** An expected failure with a message meant for the person or agent that ran slp. */
export class SlpError extends Error {
}
/** The project (or a seat's view of it) no longer exists or was replaced. */
export class GoneError extends SlpError {
}
/** A verb was used by a role that may not use it. */
export class ForbiddenError extends SlpError {
}
