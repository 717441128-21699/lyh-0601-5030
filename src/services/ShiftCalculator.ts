import { Shift } from '../types';
import {
  timeToMinutes,
  minutesToTime,
  createDateTime,
  getDatePart,
  parseDateTime,
  diffMinutes,
  roundHours,
  formatDate,
} from '../utils/dateUtils';

export interface ShiftHoursResult {
  totalMinutes: number;
  totalHours: number;
  restMinutes: number;
  workMinutes: number;
  workHours: number;
  startTime: string;
  endTime: string;
}

export interface TimeRange {
  startTime: string;
  endTime: string;
  minutes: number;
  hours: number;
}

export class ShiftCalculator {
  calculateShiftHours(shift: Shift): ShiftHoursResult {
    const startMin = timeToMinutes(shift.startTime);
    const endMin = timeToMinutes(shift.endTime);

    let totalMinutes = endMin - startMin;
    if (totalMinutes <= 0) {
      totalMinutes += 24 * 60;
    }

    let restMinutes = 0;
    if (shift.restStartTime && shift.restEndTime) {
      const restStartMin = timeToMinutes(shift.restStartTime);
      const restEndMin = timeToMinutes(shift.restEndTime);
      restMinutes = restEndMin - restStartMin;
      if (restMinutes < 0) {
        restMinutes += 24 * 60;
      }
    }

    const workMinutes = Math.max(0, totalMinutes - restMinutes);

    return {
      totalMinutes,
      totalHours: roundHours(totalMinutes / 60),
      restMinutes,
      workMinutes,
      workHours: roundHours(workMinutes / 60),
      startTime: shift.startTime,
      endTime: shift.endTime,
    };
  }

  calculateOverlapMinutes(
    range1Start: string,
    range1End: string,
    range2Start: string,
    range2End: string
  ): number {
    const r1s = parseDateTime(range1Start).getTime();
    const r1e = parseDateTime(range1End).getTime();
    const r2s = parseDateTime(range2Start).getTime();
    const r2e = parseDateTime(range2End).getTime();

    const overlapStart = Math.max(r1s, r2s);
    const overlapEnd = Math.min(r1e, r2e);

    if (overlapStart >= overlapEnd) {
      return 0;
    }

    return Math.round((overlapEnd - overlapStart) / (1000 * 60));
  }

  calculateLeaveDeductionHours(
    shift: Shift,
    date: string,
    leaveStart: string,
    leaveEnd: string
  ): TimeRange {
    const shiftStart = createDateTime(date, shift.startTime);
    let shiftEnd = createDateTime(date, shift.endTime);

    if (parseDateTime(shiftEnd) <= parseDateTime(shiftStart)) {
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = nextDay.toISOString().split('T')[0];
      shiftEnd = createDateTime(nextDayStr, shift.endTime);
    }

    const actualStart = parseDateTime(leaveStart) > parseDateTime(shiftStart) ? leaveStart : shiftStart;
    const actualEnd = parseDateTime(leaveEnd) < parseDateTime(shiftEnd) ? leaveEnd : shiftEnd;

    if (parseDateTime(actualStart) >= parseDateTime(actualEnd)) {
      return {
        startTime: actualStart,
        endTime: actualStart,
        minutes: 0,
        hours: 0,
      };
    }

    let overlapMinutes = diffMinutes(actualStart, actualEnd);

    if (shift.restStartTime && shift.restEndTime) {
      const isNightShift = parseDateTime(shiftEnd) > parseDateTime(createDateTime(date, '23:59:59')) &&
        parseDateTime(shiftStart) >= parseDateTime(createDateTime(date, '12:00:00'));

      const restStart = this.createRestDateTimeShift(date, shift.restStartTime, isNightShift);
      let restEnd = this.createRestDateTimeShift(date, shift.restEndTime, isNightShift);

      if (parseDateTime(restEnd) <= parseDateTime(restStart)) {
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().split('T')[0];
        restEnd = createDateTime(nextDayStr, shift.restEndTime);
      }
      const restOverlap = this.calculateOverlapMinutes(
        actualStart,
        actualEnd,
        restStart,
        restEnd
      );
      overlapMinutes = Math.max(0, overlapMinutes - restOverlap);
    }

    return {
      startTime: actualStart,
      endTime: actualEnd,
      minutes: overlapMinutes,
      hours: roundHours(overlapMinutes / 60),
    };
  }

  isHalfDayMorning(shift: Shift): string {
    const startMin = timeToMinutes(shift.startTime);
    const endMin = timeToMinutes(shift.endTime);
    let totalMin = endMin - startMin;
    if (totalMin <= 0) totalMin += 24 * 60;

    const midPoint = startMin + totalMin / 2;
    return minutesToTime(midPoint % (24 * 60));
  }

  getHalfDayRange(shift: Shift, date: string, isMorning: boolean): TimeRange {
    const shiftHours = this.calculateShiftHours(shift);
    const startMin = timeToMinutes(shift.startTime);
    const halfWorkMinutes = shiftHours.workMinutes / 2;

    if (isMorning) {
      const endMin = startMin + halfWorkMinutes + (shiftHours.restMinutes > 0 ? 0 : 0);
      let actualEndMin = endMin;
      if (shift.restStartTime && shift.restEndTime) {
        const restStartMin = timeToMinutes(shift.restStartTime);
        if (endMin > restStartMin) {
          actualEndMin = endMin + (timeToMinutes(shift.restEndTime) - restStartMin);
        }
      }
      return {
        startTime: createDateTime(date, shift.startTime),
        endTime: createDateTime(date, minutesToTime(actualEndMin % (24 * 60))),
        minutes: halfWorkMinutes,
        hours: roundHours(halfWorkMinutes / 60),
      };
    } else {
      let startFrom = startMin + halfWorkMinutes;
      if (shift.restStartTime && shift.restEndTime) {
        const restStartMin = timeToMinutes(shift.restStartTime);
        if (startFrom >= restStartMin) {
          startFrom += timeToMinutes(shift.restEndTime) - restStartMin;
        }
      }
      const endMin = timeToMinutes(shift.endTime);
      const endDt = endMin <= startMin
        ? createDateTime(new Date(new Date(date).getTime() + 86400000).toISOString().split('T')[0], shift.endTime)
        : createDateTime(date, shift.endTime);

      return {
        startTime: createDateTime(date, minutesToTime(startFrom % (24 * 60))),
        endTime: endDt,
        minutes: halfWorkMinutes,
        hours: roundHours(halfWorkMinutes / 60),
      };
    }
  }

  getFullDayRange(shift: Shift, date: string): TimeRange {
    const shiftHours = this.calculateShiftHours(shift);
    const endDt = timeToMinutes(shift.endTime) <= timeToMinutes(shift.startTime)
      ? createDateTime(new Date(new Date(date).getTime() + 86400000).toISOString().split('T')[0], shift.endTime)
      : createDateTime(date, shift.endTime);

    return {
      startTime: createDateTime(date, shift.startTime),
      endTime: endDt,
      minutes: shiftHours.workMinutes,
      hours: shiftHours.workHours,
    };
  }

  private createRestDateTimeShift(
    date: string,
    restTime: string,
    isNightShift: boolean
  ): string {
    const restDt = createDateTime(date, restTime);
    const restHour = parseDateTime(restDt).getHours();
    if (isNightShift && restHour < 12) {
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      return createDateTime(formatDate(nextDay), restTime);
    }
    return restDt;
  }
}
