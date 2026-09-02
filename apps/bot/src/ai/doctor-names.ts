import { doctorDisplayName, normalizeName } from "../macdent/parse.js";

/** Явные формы, если алгоритм ошибается для конкретного врача. */
const DATIVE_OVERRIDES: Record<string, string> = {
  "абдикаримова асель": "Абдикаримовой Асель",
  "абдикаримов ержан": "Абдикаримову Ержану",
  "масенов ансар": "Масенову Ансару",
};

const GIVEN_DATIVE_OVERRIDES: Record<string, string> = {
  асель: "Асель",
};

function isFemaleSurname(surname: string): boolean {
  const s = surname.toLowerCase();
  return (
    s.endsWith("ова") ||
    s.endsWith("ева") ||
    s.endsWith("ина") ||
    s.endsWith("ая") ||
    s.endsWith("ская") ||
    s.endsWith("цкая")
  );
}

function surnameInDative(surname: string, female: boolean): string {
  if (female) {
    if (surname.endsWith("ова")) return `${surname.slice(0, -1)}ой`;
    if (surname.endsWith("ева")) return `${surname.slice(0, -1)}ой`;
    if (surname.endsWith("ина")) return `${surname.slice(0, -1)}ой`;
    if (surname.endsWith("ая")) return `${surname.slice(0, -1)}ой`;
    if (surname.endsWith("ская")) return `${surname.slice(0, -2)}ской`;
    if (surname.endsWith("цкая")) return `${surname.slice(0, -2)}цкой`;
    return surname;
  }
  if (/[бвгджзклмнпрстфхцчшщ]ов$/i.test(surname)) return `${surname}у`;
  if (/[бвгджзклмнпрстфхцчшщ]ев$/i.test(surname)) return `${surname}у`;
  if (/[бвгджзклмнпрстфхцчшщ]ин$/i.test(surname)) return `${surname}у`;
  if (surname.endsWith("ый")) return `${surname.slice(0, -2)}ому`;
  if (surname.endsWith("ий")) return `${surname.slice(0, -2)}ему`;
  return surname;
}

function givenNameInDative(name: string, female: boolean): string {
  const key = normalizeName(name);
  if (GIVEN_DATIVE_OVERRIDES[key]) return GIVEN_DATIVE_OVERRIDES[key];

  if (female) {
    if (name.endsWith("ия")) return `${name.slice(0, -1)}и`;
    if (name.endsWith("ья")) return `${name.slice(0, -2)}ье`;
    if (name.endsWith("а")) return `${name.slice(0, -1)}е`;
    return name;
  }
  if (name.endsWith("й")) return `${name.slice(0, -1)}ю`;
  if (name.endsWith("ь")) return `${name.slice(0, -1)}ю`;
  if (name.endsWith("а")) return `${name.slice(0, -1)}е`;
  return `${name}у`;
}

/** Фамилия и имя в дательном падеже: «к Абдикаримовой Асель», «к Ержану». */
export function doctorNameInDative(fullName: string): string {
  const display = doctorDisplayName(fullName);
  const key = normalizeName(display);
  if (DATIVE_OVERRIDES[key]) return DATIVE_OVERRIDES[key];

  const parts = display.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return display;

  const [surname, given] = parts;
  const female = isFemaleSurname(surname);
  return `${surnameInDative(surname, female)} ${givenNameInDative(given, female)}`;
}
