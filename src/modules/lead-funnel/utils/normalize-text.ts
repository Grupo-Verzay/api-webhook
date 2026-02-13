export const normalizeText = (t: any): string => {
  return (t ?? '').toString().trim();
};

export const safeLower = (t: any): string => {
  return normalizeText(t).toLowerCase();
};
