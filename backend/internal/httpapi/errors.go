package httpapi

const CodeInvalidJSON = "INVALID_JSON"
const CodeValidationError = "VALIDATION_ERROR"
const CodeResourceConflict = "RESOURCE_CONFLICT"
const CodeInternalError = "INTERNAL_SERVER_ERROR"

type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	return e.Message
}
