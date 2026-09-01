import { CLINIC } from "../config/hours.js";
import { currentHourInClinic } from "../booking/policy.js";

export function timeOfDayGreeting(now = new Date()): string {
  const hour = currentHourInClinic(now);
  if (hour >= 5 && hour < 12) return "Доброе утро";
  if (hour >= 12 && hour < 18) return "Добрый день";
  return "Добрый вечер";
}

export function buildNewClientGreeting(now = new Date()): string {
  return `${timeOfDayGreeting(now)}! 😊
Вас приветствует стоматологическая клиника «${CLINIC.name}».
Чем мы можем вам помочь?`;
}

export function buildReturningClientGreeting(now = new Date()): string {
  return `${timeOfDayGreeting(now)}! 😊 Вижу вы уже обращались к нам — как прошла ваша последняя запись?
Могу вам чем-нибудь помочь?`;
}

export function buildDailyGreeting(isReturning: boolean, now = new Date()): string {
  return isReturning
    ? buildReturningClientGreeting(now)
    : buildNewClientGreeting(now);
}

export function isGreetingOnly(text: string): boolean {
  return /^(привет|здравствуйте|здравстуйте|добрый\s+(день|вечер|утро)|hello|hi|hey)[\s!.]*$/i.test(
    text.trim()
  );
}
