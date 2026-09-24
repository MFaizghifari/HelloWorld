// Question-type badges shared by the builder and the results view.
// Colours follow Typeform's category grouping (contact, text, choice, rating, other).
import { el } from './dom.js';
import { icon } from './icons.js';

export const TYPE_META = {
  email: { cat: 'contact', color: '#FCE7F3', ink: '#9D174D' },
  phone: { cat: 'contact', color: '#FCE7F3', ink: '#9D174D' },
  short_text: { cat: 'text', color: '#DBEAFE', ink: '#1E40AF' },
  long_text: { cat: 'text', color: '#DBEAFE', ink: '#1E40AF' },
  statement: { cat: 'text', color: '#E5E7EB', ink: '#374151' },
  multiple_choice: { cat: 'choice', color: '#EDE9FE', ink: '#5B21B6' },
  dropdown: { cat: 'choice', color: '#EDE9FE', ink: '#5B21B6' },
  yes_no: { cat: 'choice', color: '#EDE9FE', ink: '#5B21B6' },
  rating: { cat: 'rating', color: '#FEF3C7', ink: '#92400E' },
  opinion_scale: { cat: 'rating', color: '#FEF3C7', ink: '#92400E' },
  number: { cat: 'other', color: '#D1FAE5', ink: '#065F46' },
  date: { cat: 'other', color: '#D1FAE5', ink: '#065F46' },
};

export function typeTile(type, label) {
  const m = TYPE_META[type] || { color: '#E5E7EB', ink: '#374151' };
  return el('span', { class: 'type-tile', style: `background:${m.color};color:${m.ink}` }, icon(type, { size: 14 }), label !== undefined ? el('span', { text: String(label) }) : null);
}
