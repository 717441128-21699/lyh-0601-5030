import { HolidayConfig, WeekendConfig } from '../types';
import { isWeekend } from '../utils/dateUtils';

export class WorkdayChecker {
  private holidays: Map<string, HolidayConfig>;
  private makeupWorkdays: Map<string, HolidayConfig>;
  private weekendConfig: WeekendConfig;

  constructor(
    holidayConfigs: HolidayConfig[] = [],
    weekendConfig: WeekendConfig = { days: [0, 6] }
  ) {
    this.holidays = new Map();
    this.makeupWorkdays = new Map();
    this.weekendConfig = weekendConfig;

    holidayConfigs.forEach((cfg) => {
      if (cfg.type === 'holiday') {
        this.holidays.set(cfg.date, cfg);
      } else if (cfg.type === 'makeup_workday') {
        this.makeupWorkdays.set(cfg.date, cfg);
      }
    });
  }

  addHoliday(config: HolidayConfig): void {
    if (config.type === 'holiday') {
      this.holidays.set(config.date, config);
    } else if (config.type === 'makeup_workday') {
      this.makeupWorkdays.set(config.date, config);
    }
  }

  addHolidays(configs: HolidayConfig[]): void {
    configs.forEach((cfg) => this.addHoliday(cfg));
  }

  isHoliday(date: string): boolean {
    return this.holidays.has(date);
  }

  getHolidayInfo(date: string): HolidayConfig | undefined {
    return this.holidays.get(date);
  }

  isMakeupWorkday(date: string): boolean {
    return this.makeupWorkdays.has(date);
  }

  isWeekend(date: string): boolean {
    return isWeekend(date, this.weekendConfig.days);
  }

  isWorkDay(date: string, shiftWorkDays?: number[]): boolean {
    if (this.isHoliday(date) && !this.isMakeupWorkday(date)) {
      return false;
    }
    if (this.isMakeupWorkday(date)) {
      return true;
    }
    const workDays = shiftWorkDays || [1, 2, 3, 4, 5];
    const dayOfWeek = new Date(date).getDay();
    return workDays.includes(dayOfWeek);
  }

  isRestDay(date: string, shiftWorkDays?: number[]): boolean {
    return !this.isWorkDay(date, shiftWorkDays);
  }

  getDayType(date: string, shiftWorkDays?: number[]): 'workday' | 'weekend' | 'holiday' | 'makeup_workday' {
    if (this.isMakeupWorkday(date)) {
      return 'makeup_workday';
    }
    if (this.isHoliday(date)) {
      return 'holiday';
    }
    if (this.isWeekend(date)) {
      return 'weekend';
    }
    if (this.isWorkDay(date, shiftWorkDays)) {
      return 'workday';
    }
    return 'weekend';
  }

  countWorkDays(startDate: string, endDate: string, shiftWorkDays?: number[]): number {
    let count = 0;
    let current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      if (this.isWorkDay(dateStr, shiftWorkDays)) {
        count++;
      }
      current.setDate(current.getDate() + 1);
    }
    return count;
  }

  countHolidays(startDate: string, endDate: string): number {
    let count = 0;
    let current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      if (this.isHoliday(dateStr) && !this.isMakeupWorkday(dateStr)) {
        count++;
      }
      current.setDate(current.getDate() + 1);
    }
    return count;
  }

  setWeekendConfig(config: WeekendConfig): void {
    this.weekendConfig = config;
  }

  getWeekendConfig(): WeekendConfig {
    return this.weekendConfig;
  }

  clearHolidays(): void {
    this.holidays.clear();
    this.makeupWorkdays.clear();
  }

  getHolidaysInRange(startDate: string, endDate: string): HolidayConfig[] {
    const result: HolidayConfig[] = [];
    let current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      const holiday = this.holidays.get(dateStr);
      if (holiday) {
        result.push(holiday);
      }
      current.setDate(current.getDate() + 1);
    }
    return result;
  }
}
