-- Keep publisher checks on separate Worker invocations before assembling the weekly digest.
ALTER TABLE controlled_preparations ADD COLUMN result_json TEXT
  CHECK (result_json IS NULL OR json_valid(result_json));
