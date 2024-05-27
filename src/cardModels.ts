/**
 * Adaptive Card data model. Properties can be referenced in an adaptive card via the `${var}`
 * Adaptive Card syntax.
 */
export interface CardData {
  title: string;
  subtitle: string;
  description: string;
  priority: string;
  dateCreated: string;
  notificationUrl: string;
}
