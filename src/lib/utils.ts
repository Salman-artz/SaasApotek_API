// Shared utilities
export const formatCurrency = (amount: number | string) => {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
  }).format(num);
};

// Generates a random SKU
export const generateSKU = () => {
  return `SKU-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`;
};
