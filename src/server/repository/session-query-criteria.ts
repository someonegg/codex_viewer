export interface SessionListCriteria {
  readonly project?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly fresh?: boolean;
}

export interface ItemPageCriteria {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ToolDetailCriteria {
  readonly cursor: string;
}

export interface DirectiveDetailCriteria {
  readonly cursor: string;
}

export interface InternalDetailCriteria {
  readonly cursor: string;
}
