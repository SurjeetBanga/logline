// A minimal protobuf decoder for the OTLP export requests Logline accepts:
// ExportLogsServiceRequest, ExportTraceServiceRequest, and
// ExportMetricsServiceRequest. Messages
// decode into the OTLP/JSON shape (lowerCamelCase keys, hex trace and span
// IDs, 64-bit integers as decimal strings), so a single normalizer handles
// both encodings. Unknown fields are skipped, as protobuf requires.

type Json = Record<string, unknown>;

export class ProtoError extends Error { }

const MAX_DEPTH = 32;

class Reader {
  pos: number;
  constructor(readonly buf: Uint8Array, start = 0, readonly end = buf.length) { this.pos = start; }
  get done(): boolean { return this.pos >= this.end; }

  varint(): bigint {
    let result = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtoError('Truncated varint');
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
    throw new ProtoError('Malformed varint');
  }

  number(): number { return Number(BigInt.asUintN(32, this.varint())); }

  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new ProtoError('Truncated fixed64');
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(this.buf[this.pos + i]);
    this.pos += 8;
    return value;
  }

  double(): number {
    if (this.pos + 8 > this.end) throw new ProtoError('Truncated double');
    const value = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return value;
  }

  float64Field(wire: number): number {
    // A double is fixed64 on the wire; read the bits as a float.
    if (wire !== 1) throw new ProtoError('Expected a double');
    return this.double();
  }

  /** A repeated fixed64 or double field, packed (wire type 2) or not (wire type 1). */
  packed64(wire: number, read: (reader: Reader) => void): void {
    if (wire === 1) { read(this); return; }
    const bytes = this.bytes();
    const inner = new Reader(bytes);
    if (bytes.length % 8) throw new ProtoError('Truncated packed field');
    while (!inner.done) read(inner);
  }

  bytes(): Uint8Array {
    const length = Number(this.varint());
    if (!Number.isSafeInteger(length) || this.pos + length > this.end) throw new ProtoError('Truncated length-delimited field');
    const value = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

  string(): string { return new TextDecoder().decode(this.bytes()); }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) { if ((this.pos += 8) > this.end) throw new ProtoError('Truncated field'); }
    else if (wire === 2) this.bytes();
    else if (wire === 5) { if ((this.pos += 4) > this.end) throw new ProtoError('Truncated field'); }
    else throw new ProtoError(`Unsupported wire type ${wire}`);
  }

  /** Iterate fields, calling `read` with the field number and wire type. */
  fields(read: (field: number, wire: number) => boolean | void): void {
    while (!this.done) {
      const key = this.number();
      const field = key >>> 3, wire = key & 7;
      if (field === 0) throw new ProtoError('Invalid field number 0');
      const before = this.pos;
      if (read(field, wire) !== true) { this.pos = before; this.skip(wire); }
    }
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function sub(reader: Reader, depth: number, decode: (reader: Reader, depth: number) => Json): Json {
  if (depth > MAX_DEPTH) throw new ProtoError('Message nesting is too deep');
  const bytes = reader.bytes();
  return decode(new Reader(bytes), depth + 1);
}

function anyValue(r: Reader, depth: number): Json {
  const value: Json = {};
  r.fields((field, wire) => {
    if (field === 1 && wire === 2) value.stringValue = r.string();
    else if (field === 2 && wire === 0) value.boolValue = r.varint() !== 0n;
    else if (field === 3 && wire === 0) value.intValue = BigInt.asIntN(64, r.varint()).toString();
    else if (field === 4 && wire === 1) value.doubleValue = r.double();
    else if (field === 5 && wire === 2) value.arrayValue = sub(r, depth, (inner, d) => ({ values: repeated(inner, 1, d, anyValue) }));
    else if (field === 6 && wire === 2) value.kvlistValue = sub(r, depth, (inner, d) => ({ values: repeated(inner, 1, d, keyValue) }));
    else if (field === 7 && wire === 2) value.bytesValue = Buffer.from(r.bytes()).toString('base64');
    else return false;
    return true;
  });
  return value;
}

function keyValue(r: Reader, depth: number): Json {
  const value: Json = { key: '' };
  r.fields((field, wire) => {
    if (field === 1 && wire === 2) value.key = r.string();
    else if (field === 2 && wire === 2) value.value = sub(r, depth, anyValue);
    else return false;
    return true;
  });
  return value;
}

function repeated(r: Reader, number: number, depth: number, decode: (reader: Reader, depth: number) => Json): Json[] {
  const values: Json[] = [];
  r.fields((field, wire) => {
    if (field !== number || wire !== 2) return false;
    values.push(sub(r, depth, decode));
    return true;
  });
  return values;
}

function resource(r: Reader, depth: number): Json {
  const attributes: Json[] = [];
  r.fields((field, wire) => {
    if (field !== 1 || wire !== 2) return false;
    attributes.push(sub(r, depth, keyValue));
    return true;
  });
  return { attributes };
}

function scope(r: Reader, depth: number): Json {
  const value: Json = {};
  r.fields((field, wire) => {
    if (field === 1 && wire === 2) value.name = r.string();
    else if (field === 2 && wire === 2) value.version = r.string();
    else return false;
    return true;
  });
  return value;
}

function logRecord(r: Reader, depth: number): Json {
  const value: Json = { attributes: [] };
  r.fields((field, wire) => {
    if (field === 1 && wire === 1) value.timeUnixNano = r.fixed64().toString();
    else if (field === 11 && wire === 1) value.observedTimeUnixNano = r.fixed64().toString();
    else if (field === 2 && wire === 0) value.severityNumber = r.number();
    else if (field === 3 && wire === 2) value.severityText = r.string();
    else if (field === 5 && wire === 2) value.body = sub(r, depth, anyValue);
    else if (field === 6 && wire === 2) (value.attributes as Json[]).push(sub(r, depth, keyValue));
    else if (field === 9 && wire === 2) value.traceId = hex(r.bytes());
    else if (field === 10 && wire === 2) value.spanId = hex(r.bytes());
    else if (field === 12 && wire === 2) value.eventName = r.string();
    else return false;
    return true;
  });
  return value;
}

function spanEvent(r: Reader, depth: number): Json {
  const value: Json = { attributes: [] };
  r.fields((field, wire) => {
    if (field === 1 && wire === 1) value.timeUnixNano = r.fixed64().toString();
    else if (field === 2 && wire === 2) value.name = r.string();
    else if (field === 3 && wire === 2) (value.attributes as Json[]).push(sub(r, depth, keyValue));
    else return false;
    return true;
  });
  return value;
}

function status(r: Reader): Json {
  const value: Json = {};
  r.fields((field, wire) => {
    if (field === 2 && wire === 2) value.message = r.string();
    else if (field === 3 && wire === 0) value.code = r.number();
    else return false;
    return true;
  });
  return value;
}

function span(r: Reader, depth: number): Json {
  const value: Json = { attributes: [], events: [] };
  r.fields((field, wire) => {
    if (field === 1 && wire === 2) value.traceId = hex(r.bytes());
    else if (field === 2 && wire === 2) value.spanId = hex(r.bytes());
    else if (field === 4 && wire === 2) value.parentSpanId = hex(r.bytes());
    else if (field === 5 && wire === 2) value.name = r.string();
    else if (field === 6 && wire === 0) value.kind = r.number();
    else if (field === 7 && wire === 1) value.startTimeUnixNano = r.fixed64().toString();
    else if (field === 8 && wire === 1) value.endTimeUnixNano = r.fixed64().toString();
    else if (field === 9 && wire === 2) (value.attributes as Json[]).push(sub(r, depth, keyValue));
    else if (field === 11 && wire === 2) (value.events as Json[]).push(sub(r, depth, spanEvent));
    else if (field === 15 && wire === 2) value.status = status(new Reader(r.bytes()));
    else return false;
    return true;
  });
  return value;
}

// ResourceLogs/ResourceSpans { Resource resource = 1; repeated Scope* = 2; }
// Scope* { InstrumentationScope scope = 1; repeated LogRecord|Span = 2; }
function resourceGroup(itemsKey: string, scopeKey: string, item: (reader: Reader, depth: number) => Json) {
  const scoped = (r: Reader, depth: number): Json => {
    const value: Json = { [itemsKey]: [] };
    r.fields((field, wire) => {
      if (field === 1 && wire === 2) value.scope = sub(r, depth, scope);
      else if (field === 2 && wire === 2) (value[itemsKey] as Json[]).push(sub(r, depth, item));
      else return false;
      return true;
    });
    return value;
  };
  return (r: Reader, depth: number): Json => {
    const value: Json = { [scopeKey]: [] };
    r.fields((field, wire) => {
      if (field === 1 && wire === 2) value.resource = sub(r, depth, resource);
      else if (field === 2 && wire === 2) (value[scopeKey] as Json[]).push(sub(r, depth, scoped));
      else return false;
      return true;
    });
    return value;
  };
}

// NumberDataPoint { start = 2; time = 3; as_double = 4; as_int = 6 (sfixed64); attributes = 7; }
function numberPoint(r: Reader, depth: number): Json {
  const value: Json = { attributes: [] };
  r.fields((field, wire) => {
    if (field === 2 && wire === 1) value.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === 1) value.timeUnixNano = r.fixed64().toString();
    else if (field === 4 && wire === 1) value.asDouble = r.double();
    else if (field === 6 && wire === 1) value.asInt = BigInt.asIntN(64, r.fixed64()).toString();
    else if (field === 7 && wire === 2) (value.attributes as Json[]).push(sub(r, depth, keyValue));
    else return false;
    return true;
  });
  return value;
}

// HistogramDataPoint { start = 2; time = 3; count = 4; sum = 5; bucket_counts = 6; explicit_bounds = 7; attributes = 9; min = 11; max = 12; }
function histogramPoint(r: Reader, depth: number): Json {
  const value: Json = { attributes: [], bucketCounts: [], explicitBounds: [] };
  r.fields((field, wire) => {
    if (field === 2 && wire === 1) value.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === 1) value.timeUnixNano = r.fixed64().toString();
    else if (field === 4 && wire === 1) value.count = r.fixed64().toString();
    else if (field === 5) value.sum = r.float64Field(wire);
    else if (field === 6 && (wire === 1 || wire === 2)) r.packed64(wire, inner => (value.bucketCounts as string[]).push(inner.fixed64().toString()));
    else if (field === 7 && (wire === 1 || wire === 2)) r.packed64(wire, inner => (value.explicitBounds as number[]).push(inner.double()));
    else if (field === 9 && wire === 2) (value.attributes as Json[]).push(sub(r, depth, keyValue));
    else if (field === 11) value.min = r.float64Field(wire);
    else if (field === 12) value.max = r.float64Field(wire);
    else return false;
    return true;
  });
  return value;
}

// ExponentialHistogramDataPoint { attributes = 1; start = 2; time = 3; count = 4; sum = 5; min = 12; max = 13; }
// Its buckets are not read: Logline shows the average, minimum, and maximum.
function exponentialPoint(r: Reader, depth: number): Json {
  const value: Json = { attributes: [] };
  r.fields((field, wire) => {
    if (field === 1 && wire === 2) (value.attributes as Json[]).push(sub(r, depth, keyValue));
    else if (field === 2 && wire === 1) value.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === 1) value.timeUnixNano = r.fixed64().toString();
    else if (field === 4 && wire === 1) value.count = r.fixed64().toString();
    else if (field === 5) value.sum = r.float64Field(wire);
    else if (field === 12) value.min = r.float64Field(wire);
    else if (field === 13) value.max = r.float64Field(wire);
    else return false;
    return true;
  });
  return value;
}

// SummaryDataPoint { start = 2; time = 3; count = 4; sum = 5; quantile_values = 6 { quantile = 1; value = 2; }; attributes = 7; }
function summaryPoint(r: Reader, depth: number): Json {
  const value: Json = { attributes: [], quantileValues: [] };
  r.fields((field, wire) => {
    if (field === 2 && wire === 1) value.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === 1) value.timeUnixNano = r.fixed64().toString();
    else if (field === 4 && wire === 1) value.count = r.fixed64().toString();
    else if (field === 5) value.sum = r.float64Field(wire);
    else if (field === 6 && wire === 2) (value.quantileValues as Json[]).push(sub(r, depth, inner => {
      const quantile: Json = {};
      inner.fields((f, w) => {
        if (f === 1) quantile.quantile = inner.float64Field(w);
        else if (f === 2) quantile.value = inner.float64Field(w);
        else return false;
        return true;
      });
      return quantile;
    }));
    else if (field === 7 && wire === 2) (value.attributes as Json[]).push(sub(r, depth, keyValue));
    else return false;
    return true;
  });
  return value;
}

// Gauge/Sum/Histogram/... { repeated DataPoint data_points = 1; aggregation_temporality = 2; is_monotonic = 3 (Sum only); }
function metricData(point: (reader: Reader, depth: number) => Json) {
  return (r: Reader, depth: number): Json => {
    const value: Json = { dataPoints: [] };
    r.fields((field, wire) => {
      if (field === 1 && wire === 2) (value.dataPoints as Json[]).push(sub(r, depth, point));
      else if (field === 2 && wire === 0) value.aggregationTemporality = r.number();
      else if (field === 3 && wire === 0) value.isMonotonic = r.varint() !== 0n;
      else return false;
      return true;
    });
    return value;
  };
}

const METRIC_DATA: Record<number, [string, (reader: Reader, depth: number) => Json]> = {
  5: ['gauge', metricData(numberPoint)],
  7: ['sum', metricData(numberPoint)],
  9: ['histogram', metricData(histogramPoint)],
  10: ['exponentialHistogram', metricData(exponentialPoint)],
  11: ['summary', metricData(summaryPoint)]
};

// Metric { name = 1; description = 2; unit = 3; oneof data { gauge = 5; sum = 7; histogram = 9; exponential_histogram = 10; summary = 11; } }
function metric(r: Reader, depth: number): Json {
  const value: Json = {};
  r.fields((field, wire) => {
    if (field === 1 && wire === 2) value.name = r.string();
    else if (field === 2 && wire === 2) value.description = r.string();
    else if (field === 3 && wire === 2) value.unit = r.string();
    else if (METRIC_DATA[field] && wire === 2) value[METRIC_DATA[field][0]] = sub(r, depth, METRIC_DATA[field][1]);
    else return false;
    return true;
  });
  return value;
}

const resourceLogs = resourceGroup('logRecords', 'scopeLogs', logRecord);
const resourceSpans = resourceGroup('spans', 'scopeSpans', span);
const resourceMetrics = resourceGroup('metrics', 'scopeMetrics', metric);

export function decodeLogsRequest(bytes: Uint8Array): Json {
  return { resourceLogs: repeated(new Reader(bytes), 1, 0, resourceLogs) };
}

export function decodeTraceRequest(bytes: Uint8Array): Json {
  return { resourceSpans: repeated(new Reader(bytes), 1, 0, resourceSpans) };
}

export function decodeMetricsRequest(bytes: Uint8Array): Json {
  return { resourceMetrics: repeated(new Reader(bytes), 1, 0, resourceMetrics) };
}
