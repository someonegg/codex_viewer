export function CharacterCount({ value }: { value: number }) {
  return (
    <span className="character-count">
      {value.toLocaleString()} characters
    </span>
  );
}
